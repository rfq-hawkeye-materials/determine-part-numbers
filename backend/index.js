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
async function getChatGPTResponse(prompt) {
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

//
// VENDOR HANDLERS
//

// Border States handler (placeholder)
async function handleBorderStates(descriptions) {
  // Placeholder function for Border States
  return { vendor: 'borderStates', vendorDisplayName: 'Border States', partNumbers: [] };
}

// Graybar handler with sequential processing and exponential backoff
async function handleGraybar(descriptions) {
  try {
    // Initialize Pinecone client
    const pinecone = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY
    });
    const index = pinecone.index('graybar', 'https://graybar-e2q2cke.svc.aped-4627-b74a.pinecone.io');

    const pineconeResults = [];
    // Process each description sequentially
    for (const description of descriptions) {
      // Get embedding with backoff
      const vector = await getEmbedding(description);

      const queryRequest = {
        topK: 100,
        vector,
        includeMetadata: true,
      };

      const queryResponse = await index.query(queryRequest);
      console.log("Query response:", queryResponse);

      // Map over matches returned by Pinecone
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
      } catch (err) {
        console.error("Realtime search failed for description:", description, err);
        realtimeResults = [];
      }

      // Update scores based on realtime results order
      matches.forEach(match => {
        const rtIndex = realtimeResults.indexOf(match.partNumber) + 1;
        if (rtIndex) {
          match.realtimeRank = rtIndex;
        } else {
          match.realtimeRank = 9999; // Unranked items go to the bottom
        }
      });

      // Sort matches by realtime rank (lower is better)
      matches.sort((a, b) => a.realtimeRank - b.realtimeRank);

      pineconeResults.push({ description, matches });
    }

    // Use ChatGPT to determine the best match for each description sequentially
    const chatGPTResults = [];
    for (const { description, matches } of pineconeResults) {
      const prompt = generateGraybarPrompt(description, matches);
      const bestMatch = await getChatGPTResponse(prompt);
      console.log(`Explanation for "${description}": ${bestMatch.explanation}`);
      chatGPTResults.push({ description, bestMatch });
    }

    // Format and return the vendor response
    return {
      vendor: "graybar",
      vendorDisplayName: "Graybar",
      partNumbers: chatGPTResults.map(({ bestMatch }) => ({
        vendorPartNumber: bestMatch?.vendorPartNumber || "N/A",
        explanation: bestMatch?.explanation || "N/A",
      })),
    };
  } catch (error) {
    console.error("Error handling Graybar:", error);
    return null;
  }
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

http('getPartNumbers', async (req, res) => {
  // --- 1. Handle CORS ---
  console.log('Start');
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(204).send('');
    return;
  }

  // --- 2. Parse Input ---
  let { descriptions = [] } = req.body || {};
  if (!Array.isArray(descriptions) || descriptions.length === 0) {
    return res.status(400).json({ error: "No descriptions provided." });
  }
  descriptions = descriptions.map(cleanDescription);

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
