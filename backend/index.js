require('dotenv').config();
const { http } = require("@google-cloud/functions-framework");
const { Pinecone } = require('@pinecone-database/pinecone');
const cheerio = require('cheerio');

//
// HELPER FUNCTIONS
//

// Sleep helper (returns a promise that resolves after ms milliseconds)
async function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Fetch with exponential backoff for 429 rate limit errors.
async function fetchWithRetry(url, options, maxAttempts = 5) {
    let attempt = 0;
    let delay = 1000; // start with 1 second
    while (attempt < maxAttempts) {
        const response = await fetch(url, options);
        if (response.ok) {
            return response;
        } else if (response.status === 429) {
            console.warn(`Received 429 from ${url}. Retrying in ${delay}ms... (Attempt ${attempt + 1} of ${maxAttempts})`);
            await sleep(delay);
            delay *= 2; // exponential backoff
            attempt++;
        } else {
            throw new Error(`Fetch failed with status ${response.status}: ${response.statusText}`);
        }
    }
    throw new Error(`Max retry attempts reached for ${url}`);
}

// Clean description helper
function cleanDescription(description) {
    return description.replace(/^\d+\s*('|"|in|ft|lb|pack|pcs|feet)?\.?\s*-?\s*/i, "").trim();
}

function joinAndNumberSentences(...sentences) {
    return sentences
        .map((sentence, index) => `${index + 1}. ${sentence}`)
        .join(' ');
}

/**
 * Generates a prompt for a vendor using semantic search results, and (optionally) realtime search results.
 */
function generateChatGPTPrompt(vendorDisplayName, description, matches, includeRealtimeTank = false) {

    const analyzeSteps = [
        'Inferring the core category or type of the requested item from its description.',
        'Evaluating each candidate part to determine if it belongs to that inferred category.',
        'Considering the semantic similarity from the Pinecone query and the consistency of product type.',
        'Selecting the candidate that best aligns with the intended part type.'
    ];
    if (includeRealtimeTank) analyzeSteps.splice(2, 0, ['Giving the highest priority to the realtime search results score, knowing that the best candidate is usually near the top of realtime search results.']);

    const matchDetails = matches
        .map(
            (match, index) =>
                `Match ${index + 1}: Part Number: ${match.partNumber}, Score: ${match.score.toFixed(3)}, Description: ${match.description}` +
                (match.realtimeRank ? `, Realtime Rank: ${match.realtimeRank}` : '')
        )
        .join('\n');

    return `You work for an electric supply company handling RFQs by identifying the correct part numbers from a vast inventory. Use your deep domain expertise to interpret the customer's description and determine the intended type or category of the requested part.
  
A customer has requested the following item:
"${description}"

Based on a semantic search and realtime search from ${vendorDisplayName}'s website (which should be given heavy weight in decision-making), here are the top ${matches.length} closest matches from Graybar's inventory:
${matchDetails}

Critically analyze the provided matches by:
${joinAndNumberSentences(analyzeSteps)}

Use function calling to return your answer as a JSON object with two keys:
- "vendorPartNumber": the best matching ${vendorDisplayName} part number.
- "explanation": a concise explanation of your reasoning, including how you inferred the intended category and why the selected part is the best match.

Return only the JSON response, nothing else.`;
}


//
// API CALLS WITH RETRY
//

// Helper: Get vector embedding for a description (with retry)
async function getEmbedding(description) {
    const response = await fetchWithRetry("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            input: description,
            model: "text-embedding-ada-002",
        }),
    });
    const json = await response.json();
    return json.data[0].embedding; // Return the embedding vector
}

// Helper: Call ChatGPT with function calling for a structured response (with retry)
async function getChatGPTResponse(vendorDisplayName, prompt) {
    const response = await fetchWithRetry("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: "gpt-4-turbo", // or use gpt-3.5-turbo if preferred
            messages: [{ role: "user", content: prompt }],
            functions: [
                {
                    name: "select_best_match",
                    description: `Determines the most accurate ${vendorDisplayName} part number match based on the RFQ request and provided matches.`,
                    parameters: {
                        type: "object",
                        properties: {
                            vendorPartNumber: {
                                type: "string",
                                description: `The most relevant ${vendorDisplayName} part number for the RFQ.`
                            },
                            explanation: {
                                type: "string",
                                description: "A brief explanation of why this part was selected as the best match."
                            }
                        },
                        required: ["vendorPartNumber", "explanation"]
                    }
                }
            ],
            function_call: { name: "select_best_match" },
            temperature: 0,
            max_tokens: 2500
        }),
    });

    if (!response.ok) {
        throw new Error(`ChatGPT request failed: ${response.statusText}`);
    }

    const json = await response.json();
    const functionCall = json.choices[0]?.message?.function_call;
    if (functionCall && functionCall.name === "select_best_match") {
        return JSON.parse(functionCall.arguments);
    }

    throw new Error("Function call did not return the expected result");
}

// Helper: Get realtime Graybar search results
async function getRealtimeGraybarResults(query) {
    try {
        const url = `https://www.graybar.com/search/?text=${encodeURIComponent(query)}`;
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Failed to fetch realtime search results: ${response.statusText}`);
            return [];
        }
        const html = await response.text();
        const $ = cheerio.load(html);

        const skus = [];
        $('.product-listing_product-details').each((_, product) => {
            const sku = $(product).find('.product-listing_product-value').first().text().trim();
            if (sku) {
                skus.push(sku);
            }
        });

        console.log(`Found ${skus.length} SKUs from Graybar live search.`);
        return skus;
    } catch (error) {
        console.error("Error in getRealtimeGraybarResults:", error);
        return [];
    }
}

//
// MAIN HTTP FUNCTION
//

http('getPartNumbersOld', async (req, res) => {
    // --- 1. Handle CORS ---
    console.log('Start');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

});


http('getPartNumbers', async (req, res) => {
    console.log('Start');

    // Handle CORS for both GET and POST requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    let descriptions = [];

    if (req.method === 'POST') {
        // Handle JSON body for POST requests
        let { descriptions: bodyDescriptions } = req.body || {};
        if (!Array.isArray(bodyDescriptions) || bodyDescriptions.length === 0) {
            return res.status(400).json({ error: "No descriptions provided." });
        }
        descriptions = bodyDescriptions.map(cleanDescription);

        // --- 3. Initialize Vendors ---
        const vendors = [];

        // --- 4. Border States ---
        const borderStates = await handleVendor(descriptions, processBorderStates, "borderStates", "Border States");
        if (borderStates) vendors.push(borderStates);

        // --- 5. Graybar ---
        const graybar = await handleVendor(descriptions, processGraybar, "graybar", "Graybar");
        if (graybar) vendors.push(graybar);

        // --- 6. Return Consolidated Response ---
        return res.status(200).json({ vendors });

    } else if (req.method === 'GET') {
        // Handle SSE GET requests (extract descriptions from query)
        try {
            descriptions = JSON.parse(req.query.descriptions);
        } catch (error) {
            console.error("Invalid GET request format:", error);
            return res.status(400).json({ error: "Invalid descriptions format. Must be JSON array." });
        }

        if (!Array.isArray(descriptions) || descriptions.length === 0) {
            return res.status(400).json({ error: "No descriptions provided." });
        }

        descriptions = descriptions.map(cleanDescription);

        // Enable SSE (Server-Sent Events)
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Keep the connection alive with a heartbeat every 30s
        const heartbeat = setInterval(() => {
            res.write(`data: {}\n\n`);
        }, 30000);

        // Flag to track if the client has disconnected (i.e., pressed STOP)
        let clientDisconnected = false;
        req.on('close', () => {
            console.log("Client disconnected. Cancelling further processing.");
            clientDisconnected = true;
            clearInterval(heartbeat);
        });


        const allResults = [];

        // Process descriptions sequentially with progress updates
        for (let i = 0; i < descriptions.length; i++) {

            if (clientDisconnected) {
                console.log("Processing stopped due to client disconnection.");
                break;
            }

            const description = descriptions[i];

            // Process all vendors for this description and gather the results
            const vendorResults = await processAllVendorsForDescription(description);
            allResults.push({ description, vendors: vendorResults });

            // Send one SSE update for this description with all vendor results
            res.write(`data: ${JSON.stringify({
                description,
                vendors: vendorResults,
                progress: ((i + 1) / descriptions.length) * 100
            })}\n\n`);
        }

        // Send final completion message with all results
        if (!clientDisconnected) {
            res.write(`data: ${JSON.stringify({ complete: true, results: allResults })}\n\n`);
            res.end();
            clearInterval(heartbeat);
        }
        return;
    } else {
        return res.status(405).json({ error: "Method not allowed." });
    }
});


/**
 * Processes all vendors for a given description.
 * Returns an array of vendor results.
 */
async function processAllVendorsForDescription(description) {
    const vendorResults = [];

    // Process Border States
    const borderStatesResult = await processBorderStates(description);
    if (borderStatesResult) {
        vendorResults.push(borderStatesResult);
    }

    // Process Graybar
    const graybarResult = await processGraybar(description);
    if (graybarResult) {
        vendorResults.push(graybarResult);
    }

    // In the future, you can add more vendor processing here.

    return vendorResults;
}


/**
 * Unified vendor processing helper.
 * Options:
 *   - vendor: internal vendor key (e.g., "graybar" or "borderStates")
 *   - displayName: Vendor display name.
 *   - indexName: Pinecone index name.
 *   - pineconeURL: URL for the Pinecone index.
 *   - realtime: Boolean indicating whether realtime search adjustments should be applied.
 */
async function processVendor(description, options) {
    try {
        // Initialize Pinecone client and select the vendor's index.
        const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
        const index = pinecone.index(options.indexName, options.pineconeURL);

        // Get embedding for the description.
        const vector = await getEmbedding(description);

        // Query Pinecone.
        const queryRequest = {
            topK: 100,
            vector,
            includeMetadata: true,
            ...(options.namespace && { namespace: options.namespace })
        };
        const queryResponse = await index.query(queryRequest);

        // Map over returned matches.
        let matches = queryResponse.matches.map(match => ({
            partNumber: match.metadata?.part_number || 'N/A',
            description: match.metadata?.description || '',
            score: match.score || 0,
            metadata: match.metadata,
        }));

        // First, sort by score (higher is better).
        matches.sort((a, b) => b.score - a.score);

        // If realtime adjustments are enabled, incorporate realtime search results.
        if (options.realtime) {
            let realtimeResults = [];
            try {
                realtimeResults = await getRealtimeGraybarResults(description);
            } catch (err) {
                console.error("Realtime search failed for description:", description, err);
            }
            matches.forEach(match => {
                const rtIndex = realtimeResults.indexOf(match.partNumber) + 1;
                match.realtimeRank = rtIndex || 9999;
            });
            // Sort matches by realtime rank (lower is better).
            matches.sort((a, b) => a.realtimeRank - b.realtimeRank);
        }

        // Generate prompt using a unified ChatGPT prompt generator.
        // For Graybar, the 'realtime' flag is true; for Border States, false.
        const prompt = generateChatGPTPrompt(options.displayName, description, matches, options.realtime);
        const bestMatch = await getChatGPTResponse(options.displayName, prompt);

        return {
            vendorDisplayName: options.displayName,
            vendor: options.vendor,
            description,
            partNumber: bestMatch.vendorPartNumber || "N/A",
            explanation: bestMatch.explanation || ""
        };
    } catch (error) {
        console.error(`Error processing ${options.displayName} for description:`, description, error);
        return {
            vendorDisplayName: options.displayName,
            vendor: options.vendor,
            description,
            partNumber: "N/A",
            explanation: error.message || "Error processing description"
        };
    }
}

/**
 * Wrapper for Graybar vendor processing.
 * Uses realtime search adjustments.
 */
async function processGraybar(description) {
    const vendorOptions = {
        vendor: "graybar",
        displayName: "Graybar",
        indexName: "graybar",
        pineconeURL: "https://graybar-e2q2cke.svc.aped-4627-b74a.pinecone.io",
        realtime: true
    };
    return await processVendor(description, vendorOptions);
}

/**
 * Wrapper for Border States vendor processing.
 * Does NOT use realtime search.
 */
async function processBorderStates(description) {
    const vendorOptions = {
        vendor: "borderStates",
        displayName: "Border States",
        indexName: "borderstates",
        pineconeURL: "https://vendors-e2q2cke.svc.aped-4627-b74a.pinecone.io",
        realtime: false,
        namespace: "borderStates"
    };
    return await processVendor(description, vendorOptions);
}

/**
 * Handler for processing multiple descriptions for a vendor.
 * Aggregates results into a standardized response.
 */
async function handleVendor(descriptions, processFunction, vendorKey, displayName) {
    const results = [];
    for (const description of descriptions) {
        const result = await processFunction(description);
        results.push(result);
    }
    return {
        vendor: vendorKey,
        vendorDisplayName: displayName,
        partNumbers: results
    };
}
