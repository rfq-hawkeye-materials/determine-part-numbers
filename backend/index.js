const { http } = require('@google-cloud/functions-framework');

// If on Node.js <18, uncomment the following:
// const fetch = require('node-fetch'); 

// Your function name in GCF must match the export below
http('partNumberLookup', async (req, res) => {
  // --- 1. Handle CORS ---
  res.set('Access-Control-Allow-Origin', '*'); // Allow all origins
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  // Preflight check
  if (req.method === 'OPTIONS') {
    // No content needed for preflight
    res.status(204).send('');
    return;
  }

  // --- 2. Parse Input ---
  // Expecting JSON body: { "descriptions": ["12 AWG THHN Copper Wire", "1/2 Inch PVC Conduit", ...] }
  const { descriptions = [] } = req.body || {};
  if (!Array.isArray(descriptions) || descriptions.length === 0) {
    return res.status(400).json({ error: "No descriptions provided." });
  }

  // Join descriptions with newlines so we can pass them as a single user message
  const joinedDescriptions = descriptions.join('\n');

  // --- 3. Build OpenAI payload for function calling ---
  // 3a. Read from environment (or hardcode for demo)
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  const fineTunedModel = process.env.FT_MODEL_NAME || 'gpt-3.5-turbo-0613';

  // 3b. Define the function schema for returning multiple part numbers
  const functions = [
    {
      name: "lookupParts",
      description: "Returns an array of part numbers for multiple item descriptions",
      parameters: {
        type: "object",
        properties: {
          partNumbers: {
            type: "array",
            items: {
              type: "string",
              description: "A single part number"
            }
          }
        },
        required: ["partNumbers"]
      }
    }
  ];

  // 3c. Create the ChatCompletion request body
  const payload = {
    model: fineTunedModel,
    messages: [
      {
        role: "system",
        content: "You are an AI that returns the correct part numbers for multiple item descriptions, each on its own line. " +
          "Respond by calling the function with an array of part numbers. No additional text."
      },
      {
        role: "user",
        content: joinedDescriptions
      }
    ],
    functions: functions,
    temperature: 0 // for deterministic output
    // Optional: max_tokens: 100
  };

  // --- 4. Call OpenAI API ---
  try {
    const apiResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${OPENAI_API_KEY}`
      },
      body: JSON.stringify(payload)
    });

    if (!apiResponse.ok) {
      const errText = await apiResponse.text();
      console.error("OpenAI API error:", errText);
      return res.status(apiResponse.status).json({ error: errText });
    }

    const json = await apiResponse.json();

    // --- 5. Parse Function Call Output ---
    if (
      json.choices &&
      json.choices.length > 0 &&
      json.choices[0].message &&
      json.choices[0].message.function_call
    ) {
      const funcCall = json.choices[0].message.function_call;
      const args = JSON.parse(funcCall.arguments);
      // Expecting: { "partNumbers": ["12345","67890",...] }
      const partNumbers = args.partNumbers || [];

      // Return the partNumbers array to the caller
      return res.status(200).json({ partNumbers });
    } else {
      // No function call or no function_call.arguments
      return res.status(200).json({ partNumbers: [] });
    }
  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: error.message });
  }
});
