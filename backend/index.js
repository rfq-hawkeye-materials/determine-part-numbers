require('dotenv').config();
const { http } = require("@google-cloud/functions-framework");
const cheerio = require('cheerio');
const levenshtein = require('fast-levenshtein');


// --- Define the default vendor configurations ---
const vendorConfigs = [
    {
        vendor: "wesco",
        displayName: "Wesco",
        processFunction: processWesco, // your existing function
    },
    {
        vendor: "graybar",
        displayName: "Graybar",
        processFunction: processGraybar, // your existing function
    },
    {
        vendor: "borderStates",
        displayName: "Border States",
        processFunction: processBorderStates, // your existing function
    },
    // {
    //     vendor: "vendor4",
    //     displayName: "Vendor 4",
    //     processFunction: async (description) => {
    //         return {
    //             vendorDisplayName: "Vendor 4",
    //             vendor: "vendor4",
    //             description,
    //             partNumber: "N/A",
    //             explanation: "Vendor 4 is not yet implemented."
    //         };
    //     }
    // }
];

// HELPER FUNCTIONS

function computeSimilarity(a, b) {
    a = a.toLowerCase();
    b = b.toLowerCase();
    const distance = levenshtein.get(a, b);
    const maxLen = Math.max(a.length, b.length);
    return maxLen === 0 ? 1 : 1 - distance / maxLen;
}

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
    // Remove any leading or trailing whitespace and common stray punctuation
    return description.replace(/^[\s\-.,;:'"]+|[\s\-.,;:'"]+$/g, "").trim();
}

function joinAndNumberSentences(...sentences) {
    return sentences
        .map((sentence, index) => `${index + 1}. ${sentence}`)
        .join(' ');
}




/**
 * Generates a prompt for a vendor using semantic search results and realtime search results,
 * with realtime results given a configurable weight.
 *
 * @param {string} vendorDisplayName - The vendor's display name.
 * @param {string} description - The customer's requested item description.
 * @param {Array} matches - An array of match objects.
 * @param {number} realtimeWeight - A number between 0 and 1 representing realtime weight.
 * @returns {string} - The constructed prompt.
 */
function generateChatGPTPrompt(vendorDisplayName, description, matches, realtimeWeight = 0) {

    // Define the base analysis steps.
    const analyzeSteps = [
        'Inferring the core category or type of the requested item from its description.',
        'Evaluating each candidate part to determine if it belongs to that inferred category.'
    ];

    // Insert a realtime search results evaluation step if realtimeWeight is greater than 0.
    if (realtimeWeight > 0) {
        if (realtimeWeight >= 0.75) {
            analyzeSteps.push(`Giving high precedence to realtime search results (weight: ${Math.round(realtimeWeight * 100)}%), prioritizing parts with superior realtime rankings.`);
        } else if (realtimeWeight >= 0.25) {
            analyzeSteps.push(`Considering realtime search results moderately (weight: ${Math.round(realtimeWeight * 100)}%) along with semantic similarity and product type.`);
        } else {
            analyzeSteps.push(`Realtime search results should be considered but with low priority (weight: ${Math.round(realtimeWeight * 100)}%).`);
        }
    }

    // Add the remaining analysis steps.
    analyzeSteps.push(
        'Considering the semantic similarity from the Pinecone query and the consistency of product type.',
        'Selecting the candidate that best aligns with the intended part type.'
    );

    const matchDetails = matches
        .map(
            (match, index) =>
                `Match ${index + 1}: Part Number: ${match.partNumber}, Score: ${match.score.toFixed(3)}, Description: ${match.description}` +
                (realtimeWeight > 0 && match.realtimeRank ? `, Realtime Rank: ${match.realtimeRank === 9999 ? 'N/A' : match.realtimeRank}` : '')
        )
        .join('\n');


    return `You work for an electric supply company handling RFQs by identifying the correct part numbers from a vast inventory. Use your deep domain expertise to interpret the customer's description and determine the intended type or category of the requested part.
  
A customer has requested the following item:
"${description}"

Based on a semantic search${realtimeWeight > 0 ? ` and realtime search from ${vendorDisplayName}'s website (realtime search weight: ${Math.round(realtimeWeight * 100)}%)` : ''}, here are the top ${matches.length} closest matches from ${vendorDisplayName}'s inventory:
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


// New helper function to route realtime search based on vendor
async function getRealtimeResults(vendor, description) {
    if (vendor === "graybar") {
        return await getRealtimeGraybarResults(description);
    } else if (vendor === "wesco") {
        return await getRealtimeWescoResults(description);
    } else {
        console.warn(`Realtime search not implemented for vendor: ${vendor}`);
        return [];
    }
}


// Helper: Get realtime Graybar search results
async function getRealtimeGraybarResults(query) {
    try {
        const url = `https://www.graybar.com/search/?text=${encodeURIComponent(query)}`;
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Failed to fetch realtime Graybar search results: ${response.statusText}`);
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

// Helper: Get realtime Wesco search results
async function getRealtimeWescoResults(query) {
    try {
        const url = `https://buy.wesco.com/fsearch?q=${encodeURIComponent(query.replace(/#/,''))}&clp=false`; // hashtag seems to cause issue in the search results
        const response = await fetch(url);
        if (!response.ok) {
            console.error(`Failed to fetch realtime search results: ${response.statusText}`);
            return [];
        }
        const html = await response.text();
        const $ = cheerio.load(html);

        const skus = [];
        // For each SKU container, get the text of the second span.
        $('.c-product-search-result__header-info--sku').each((_, element) => {
            const sku = $(element).find('span:nth-child(2)').text().trim();
            if (sku) {
                skus.push(sku);
            }
        });

        console.log(`Found ${skus.length} SKUs from Wesco live search.`);
        return skus;
    } catch (error) {
        console.error("Error in getRealtimeWescoResults:", error);
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
    const vendorParam = (req.query.vendor || req.body?.vendor || '').toLowerCase();

    // If a vendor is specified, filter the vendorConfigs array; otherwise use all vendors.
    let selectedVendors;
    if (vendorParam) {
        selectedVendors = vendorConfigs.filter(v => v.vendor.toLowerCase() === vendorParam);
        if (selectedVendors.length === 0) {
            return res.status(400).json({
                error: "Invalid vendor parameter provided. Allowed values: " +
                    vendorConfigs.map(v => v.vendor).join(', ')
            });
        }
    } else {
        selectedVendors = vendorConfigs;
    }

    if (req.method === 'POST') {
        // POST: Parse JSON body descriptions.
        let { descriptions: bodyDescriptions } = req.body || {};
        if (!Array.isArray(bodyDescriptions) || bodyDescriptions.length === 0) {
            return res.status(400).json({ error: "No descriptions provided." });
        }
        descriptions = bodyDescriptions.map(cleanDescription);

        const vendors = [];
        // Process each selected vendor uniformly.
        for (const vendor of selectedVendors) {
            const result = await handleVendor(
                descriptions,
                vendor.processFunction,
                vendor.vendor,
                vendor.displayName
            );
            vendors.push(result);
        }
        return res.status(200).json({ vendors });

    } else if (req.method === 'GET') {
        // GET: Extract descriptions from query (expecting a JSON array).
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

        // Setup SSE (Server-Sent Events)
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        const heartbeat = setInterval(() => { res.write(`data: {}\n\n`); }, 30000);

        let clientDisconnected = false;
        req.on('close', () => {
            console.log("Client disconnected. Cancelling further processing.");
            clientDisconnected = true;
            clearInterval(heartbeat);
        });

        const allResults = [];
        // Process each description and for each, loop through the selected vendors.
        for (let i = 0; i < descriptions.length; i++) {
            if (clientDisconnected) break;
            const description = descriptions[i];
            let vendorResults = [];
            for (const vendor of selectedVendors) {
                const result = await vendor.processFunction(description);
                vendorResults.push(result);
            }
            allResults.push({ description, vendors: vendorResults });
            res.write(`data: ${JSON.stringify({
                description,
                vendors: vendorResults,
                progress: ((i + 1) / descriptions.length) * 100
            })}\n\n`);
        }

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
 * Unified vendor processing helper.
 * Options:
 *   - vendor: internal vendor key (e.g., "graybar" or "borderStates")
 *   - displayName: Vendor display name.
 *   - indexName: Pinecone index name.
 *   - pineconeURL: URL for the Pinecone index.
 *   - realtimeWeight: Number between 0 and 1 indicating how much weight realtime search adjustments should be given. If no results are available, use 0.
 */
async function processVendor(description, options) {
    try {

        if (options.checkCorrections) {
            const correctionResult = await checkCorrections(description, options.vendor);
            if (correctionResult) {
                console.log("Using correction result for description:", description);
                return {
                    vendorDisplayName: options.displayName,
                    vendor: options.vendor,
                    description,
                    partNumber: correctionResult.partNumber,
                    explanation: correctionResult.explanation
                };
            }
        }

        const { pineconeURL, namespace } = options;
        let { realtimeWeight } = options;
        const url = `${pineconeURL}/records/namespaces/${namespace}/search`;
        console.log({ url });

        const payload = {
            query: {
                inputs: { text: description },
                top_k: 100
            },
            fields: [
                "description",
                "part_number"
            ],
            rerank: {
                model: "cohere-rerank-3.5",
                top_n: 25,
                rank_fields: ["text"]
            }
        }

        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Api-Key": process.env.PINECONE_API_KEY,
                "Content-Type": "application/json",
                "X-Pinecone-API-Version": "2025-01"
            },
            body: JSON.stringify(payload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            throw new Error(`Status ${response.status}: ${errorText}`);
        }

        const queryResponse = await response.json();

        // Map over returned matches.
        let matches = queryResponse.result.hits.map(match => ({
            partNumber: match?.fields.part_number || 'N/A',
            description: match?.fields.description || '',
            score: match?._score || 0
        }));

        // If realtime adjustments are enabled, incorporate realtime search results.
        if (realtimeWeight > 0) {
            let realtimeResults = [];
            try {
                realtimeResults = await getRealtimeResults(options.vendor, description);
                console.log(`Found ${realtimeResults.length} realtime results.`);
            } catch (err) {
                console.error("Realtime search failed for description:", description, err);
                realtimeWeight = 0;
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
        const prompt = generateChatGPTPrompt(options.displayName, description, matches, realtimeWeight);
        // console.log(prompt);
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
        pineconeURL: "https://vendors2-e2q2cke.svc.gcp-us-central1-4a9f.pinecone.io",
        realtimeWeight: .9,
        namespace: "graybar",
        checkCorrections: true
    };
    return await processVendor(description, vendorOptions);
}

/**
 * Wrapper for Wesco vendor processing.
 * Uses realtime search adjustments.
 */
async function processWesco(description) {
    const vendorOptions = {
        vendor: "wesco",
        displayName: "Wesco",
        pineconeURL: "https://vendors2-e2q2cke.svc.gcp-us-central1-4a9f.pinecone.io",
        realtimeWeight: .2,
        namespace: "wesco",
        checkCorrections: true
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
        pineconeURL: "https://vendors2-e2q2cke.svc.gcp-us-central1-4a9f.pinecone.io",
        realtimeWeight: 0,
        namespace: "borderStates",
        checkCorrections: true
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



async function checkCorrections(description, vendor) {
    const url = `https://feedback-e2q2cke.svc.gcp-us-central1-4a9f.pinecone.io/records/namespaces/${vendor}/search`;
    const payload = {
        query: {
            inputs: { text: description },
            top_k: 20
        },
        fields: ["part_number", "reason", "text"],
        // rerank: {
        //     model: "cohere-rerank-3.5",
        //     top_n: 1,
        //     rank_fields: ["text"]
        // }
    };

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "Api-Key": process.env.PINECONE_API_KEY,
                "Content-Type": "application/json",
                "X-Pinecone-API-Version": "2025-01"
            },
            body: JSON.stringify(payload)
        });
        if (!response.ok) {
            const errorText = await response.text();
            console.error("Corrections query error:", response.status, errorText);
            return null;
        }

        const result = await response.json();
        if (result?.result?.hits?.length > 0) {
            // Filter for hits with a score of at least 0.9
            const hits = result.result.hits;
            const goodHits = hits.filter(hit => hit._score >= 0.89);


            // 1. Check for an exact match (case-insensitive)
            if (goodHits.length) {
                for (const hit of goodHits) {
                    if (hit.fields.text && hit.fields.text.toLowerCase() === description.toLowerCase()) {
                        return {
                            partNumber: hit.fields.part_number,
                            explanation: `Exact match found in feedback database: ${hit.fields.reason}`
                        };
                    }
                }
            }


            // 2. Group high-confidence matches using the "Max Score Plus Count Bonus" approach
            const HIGH_CONFIDENCE_THRESHOLD = 0.925;
            const LAMBDA = 0.01;
            const highConfidenceHits = hits.filter(hit => hit._score >= HIGH_CONFIDENCE_THRESHOLD);

            if (highConfidenceHits.length > 0) {
                // Group hits by part_number
                const groups = {};
                highConfidenceHits.forEach(hit => {
                    const partNumber = hit.fields.part_number;
                    if (!groups[partNumber]) {
                        groups[partNumber] = { hits: [] };
                    }
                    groups[partNumber].hits.push(hit);
                });

                // Compute group score: groupScore = maxScore + LAMBDA * (count - 1)
                let bestGroupPartNumber = null;
                let bestGroupScore = -Infinity;
                for (const partNumber in groups) {
                    const groupHits = groups[partNumber].hits;
                    const maxScore = groupHits.reduce((max, hit) => Math.max(max, hit._score), 0);
                    const count = groupHits.length;
                    const groupScore = maxScore + LAMBDA * (count - 1);
                    groups[partNumber].groupScore = groupScore;

                    if (groupScore > bestGroupScore) {
                        bestGroupScore = groupScore;
                        bestGroupPartNumber = partNumber;
                    }
                }

                if (bestGroupPartNumber !== null) {
                    const bestGroup = groups[bestGroupPartNumber];
                    // Pick the representative hit with the highest score within the group
                    const representativeHit = bestGroup.hits.reduce((prev, curr) =>
                        curr._score > prev._score ? curr : prev, bestGroup.hits[0]
                    );
                    return {
                        partNumber: bestGroupPartNumber,
                        explanation: `Grouped high-confidence match from feedback database semantic search with group score of ${bestGroupScore.toFixed(3)}. Reason: ${representativeHit.fields.reason}`
                    };
                }
            }


            // 3. Fuzzy match among the top 20
            //    - Compute similarity for each and pick the highest similarity
            //    - If the highest similarity is at least 0.95, return that match
            let bestFuzzyMatch = null;
            let bestFuzzyScore = 0;

            for (const hit of hits) {
                const text = hit.fields.text || "";
                const similarity = computeSimilarity(text, description);
                if (similarity > bestFuzzyScore) {
                    bestFuzzyScore = similarity;
                    bestFuzzyMatch = hit;
                }
            }

            if (bestFuzzyMatch && bestFuzzyScore >= 0.935) {
                return {
                    partNumber: bestFuzzyMatch.fields.part_number,
                    explanation: `Fuzzy match found in feedback database (similarity: ${bestFuzzyScore.toFixed(3)}): ${bestFuzzyMatch.fields.reason}`
                };
            }
        }
        return null;
    } catch (error) {
        console.error("Error in checkCorrections:", error);
        return null;
    }
}
