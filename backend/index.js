require('dotenv').config();
const { http } = require("@google-cloud/functions-framework");
const { Pinecone } = require('@pinecone-database/pinecone');
const cheerio = require('cheerio');

http('getPartNumbers', async (req, res) => {
    // --- 1. Handle CORS ---
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
    res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
        res.status(204).send('');
        return;
    }

    // --- 2. Parse Input ---
    const { descriptions = [] } = req.body || {};
    if (!Array.isArray(descriptions) || descriptions.length === 0) {
        return res.status(400).json({ error: "No descriptions provided." });
    }

    // --- 3. Initialize Vendors ---
    const vendors = [];

    // --- 4. Border States ---
    const borderStates = await handleBorderStates(descriptions);
    if (borderStates) vendors.push(borderStates);

    // --- 5. Graybar ---
    const graybar = await handleGraybar(descriptions);
    if (graybar) vendors.push(graybar);


    // --- 6. Return Consolidated Response ---
    return res.status(200).json({ vendors });
});


async function handleBorderStates(descriptions) {
    // Placeholder function for Border States
    // Add functionality here as needed for Border States
    return null; // Returning null for now, meaning no data for this vendor
}

async function handleGraybar(descriptions) {
    try {
        // Initialize Pinecone client
        const pinecone = new Pinecone({
            apiKey: process.env.PINECONE_API_KEY
        });

        const index = pinecone.index('graybar', 'https://graybar-e2q2cke.svc.aped-4627-b74a.pinecone.io');

        // Query Pinecone for top k matches for each description
        const pineconeResults = await Promise.all(
            descriptions.map(async (description) => {
                const vector = await getEmbedding(description);
                const queryRequest = {
                    "topK": 100,
                    vector,
                    "includeMetadata": true,
                    // "namespace": npc_id
                }

                const queryResponse = await index.query(queryRequest);
                console.log("Query response:", queryResponse);
                // Extract top matches with metadata
                let matches = queryResponse.matches.map((match) => ({
                    partNumber: match.metadata?.part_number || 'N/A',
                    description: match.metadata.description || '',
                    score: match.score || 0,
                    metadata: match.metadata,
                }));

                // --- Incorporate Realtime Search from Graybar's Website ---
                let realtimeResults = [];
                try {
                    realtimeResults = await getRealtimeGraybarResults(description);
                    // console.log("Realtime results:", realtimeResults);
                } catch (err) {
                    console.error("Realtime search failed for description:", description, err);
                    realtimeResults = [];
                }

                // Update scores based on realtime results order (if a match exists)
                matches.forEach(match => {
                    const rtIndex = realtimeResults.indexOf(match.partNumber) + 1;
                    if (rtIndex) {
                        // Apply a bonus weight based on the rank (lower rank means higher bonus)
                        // const bonus = (1 / rtIndex); // Adjust the multiplier as needed
                        // match.score = match.score + bonus;
                        match.realtimeRank = rtIndex;
                    } else {
                        match.realtimeRank = Infinity; // Push unranked items to the bottom
                    }
                });

                // Sort matches by the updated score in descending order
                matches.sort((a, b) => a.realtimeRank - b.realtimeRank);
                // --- End Realtime Search Integration ---

                return { description, matches };

            })
        );

        // Use ChatGPT to determine the best match for each description
        const chatGPTResults = await Promise.all(
            pineconeResults.map(async ({ description, matches }) => {
                const prompt = generateGraybarPrompt(description, matches);
                // console.log(prompt);
                const bestMatch = await getChatGPTResponse(prompt);
                // Log the explanation for debugging purposes
                console.log(`Explanation for "${description}": ${bestMatch.explanation}`);
                return {
                    description,
                    bestMatch,
                };
            })
        );

        // Format the result for the vendor
        return {
            vendor: "graybar",
            partNumbers: chatGPTResults.map(({ bestMatch }) => {
                return {
                    vendorPartNumber: bestMatch?.vendorPartNumber || "N/A",
                    explanation: bestMatch?.explanation || "N/A",
                }
            }),
        };
    } catch (error) {
        console.error("Error handling Graybar:", error);
        return null; // Return null to avoid breaking the response
    }
}


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

        // Find the script tag containing "event": "ListingPage"
        const skus = [];

        // Iterate through each product container
        $('.product-listing_product-details').each((_, product) => {
            // Find the SKU inside "product-listing_product-value"
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




// Helper function: Generate prompt for ChatGPT
function generateGraybarPrompt(description, matches) {
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
  
Based on a semantic search and realtime search from Graybar's website (which should be given heavy weight in decision-making), here are the top ${matches.length} closest matches from Graybar's inventory:
${matchDetails}
  
Critically analyze the provided matches by:
1. Inferring the core category or type of the requested item from its description.
2. Evaluating each candidate part to determine if it belongs to that inferred category.
3. Giving the highest priority to the realtime search results score, knowing that the best candidate is usually near the top of realtime search results.
4. Considering the semantic similarity from the Pinecone query and the consistency of product type.
5. Selecting the candidate that best aligns with the intended part type.
  
  Use function calling to return your answer as a JSON object with two keys:
  - "vendorPartNumber": the best matching Graybar part number.
  - "explanation": a concise explanation of your reasoning, including how you inferred the intended category and why the selected part is the best match.
  
  Return only the JSON response, nothing else.`;
}


// Helper function: Get vector embedding for a description
async function getEmbedding(description) {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            input: description,
            model: "text-embedding-ada-002", // Replace with your embedding model
        }),
    });

    if (!response.ok) {
        throw new Error(`Embedding generation failed: ${response.statusText}`);
    }

    const json = await response.json();
    return json.data[0].embedding; // Return the embedding vector
}

// HELPER: Call ChatGPT with function calling for a structured response
async function getChatGPTResponse(prompt) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
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
                    description: "Determines the most accurate Graybar part number match based on the RFQ request and provided matches.",
                    parameters: {
                        type: "object",
                        properties: {
                            vendorPartNumber: {
                                type: "string",
                                description: "The most relevant Graybar part number for the RFQ."
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
            function_call: { name: "select_best_match" }, // Force the function call
            temperature: 0, // Lower temperature for deterministic output,
            max_tokens: 2500
        }),
    });

    if (!response.ok) {
        throw new Error(`ChatGPT request failed: ${response.statusText}`);
    }

    const json = await response.json();

    // Extract and parse the function call arguments
    const functionCall = json.choices[0]?.message?.function_call;
    if (functionCall && functionCall.name === "select_best_match") {
        return JSON.parse(functionCall.arguments);
    }

    throw new Error("Function call did not return the expected result");
}


// Helper function: Extract the best part number from ChatGPT response
function extractBestPartNumber(responseText) {
    const match = responseText.match(/Part Number:\s*(\S+)/i);
    return match ? match[1] : null;
}