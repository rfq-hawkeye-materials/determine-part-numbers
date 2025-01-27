const { http } = require('@google-cloud/functions-framework');
// Import dependencies if not already included
const { PineconeClient } = require('@pinecone-database/pinecone'); // Assume Pinecone Client library
// const fetch = require('node-fetch'); // Uncomment for Node.js <18

http('partNumberLookup', async (req, res) => {

  res.status(200).send('Hello, World!');
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

  // --- 4. Border States (Stub) ---
  const borderStates = await handleBorderStates(descriptions);
  if (borderStates) {
    vendors.push(borderStates);
  }

  // --- 5. Graybar ---
  const graybar = await handleGraybar(descriptions);
  if (graybar) {
    vendors.push(graybar);
  }

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
    const pinecone = new PineconeClient();
    await pinecone.init({
      apiKey: process.env.PINECONE_API_KEY,
      environment: process.env.PINECONE_ENVIRONMENT,
    });

    const index = pinecone.Index(process.env.PINECONE_INDEX_NAME);

    // Query Pinecone for top 10 matches for each description
    const pineconeResults = await Promise.all(
      descriptions.map(async (description) => {
        const queryResponse = await index.query({
          queryRequest: {
            vector: await getEmbedding(description), // Get vector representation of description
            topK: 10,
            includeMetadata: true,
          },
        });

        // Extract top 10 matches with metadata
        return {
          description,
          matches: queryResponse.matches.map((match) => ({
            partNumber: match.metadata?.part_number || 'N/A',
            score: match.score || 0,
            metadata: match.metadata,
          })),
        };
      })
    );

    // Use ChatGPT to determine the best match for each description
    const chatGPTResults = await Promise.all(
      pineconeResults.map(async ({ description, matches }) => {
        const prompt = generateGraybarPrompt(description, matches);
        const bestMatch = await getChatGPTResponse(prompt);
        return {
          description,
          bestMatch,
        };
      })
    );

    // Format the result for the vendor
    return {
      vendor: "graybar",
      partNumbers: chatGPTResults.map(({ bestMatch }) => bestMatch?.partNumber || "N/A"),
    };
  } catch (error) {
    console.error("Error handling Graybar:", error);
    return null; // Return null to avoid breaking the response
  }
}

// Helper function: Generate prompt for ChatGPT
function generateGraybarPrompt(description, matches) {
  const matchDetails = matches
    .map(
      (match, index) =>
        `Match ${index + 1}: Part Number: ${match.partNumber}, Score: ${match.score.toFixed(2)}`
    )
    .join('\n');

  return `The following are the top 10 matches for the description "${description}":\n${matchDetails}\n\nWhich part number best matches the description, and why?`;
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

// Helper function: Query ChatGPT
async function getChatGPTResponse(prompt) {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`ChatGPT request failed: ${response.statusText}`);
  }

  const json = await response.json();
  const responseText = json.choices[0]?.message?.content || "";
  const partNumber = extractBestPartNumber(responseText); // Extract part number from response
  return { partNumber, explanation: responseText };
}

// Helper function: Extract the best part number from ChatGPT response
function extractBestPartNumber(responseText) {
  const match = responseText.match(/Part Number:\s*(\S+)/i);
  return match ? match[1] : null;
}
