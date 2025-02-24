const { EventSource } = require('eventsource');

async function testFunction() {
  // Sample input: an array of part descriptions
  const sampleInput = ["pulling lube"];

  // Encode the input as a JSON string and then URL-encode it
  const queryParam = encodeURIComponent(JSON.stringify(sampleInput));
  const url = `http://localhost:8080/getPartNumbers?descriptions=${queryParam}`;

  console.log("Connecting to:", url);

  // Create an EventSource connection using the package
  const eventSource = new EventSource(url);

  // Listen for messages from the Cloud Function
  eventSource.onmessage = (event) => {
    try {
      // Parse the received event data as JSON
      const data = JSON.parse(event.data);
      console.log("SSE event received:", data);

      // If the message indicates that processing is complete, close the connection
      if (data.complete) {
        console.log("Processing complete:", data.results);
        eventSource.close();
      }
    } catch (err) {
      console.error("Error parsing SSE data:", err);
    }
  };

  // Handle errors (e.g., connection loss)
  eventSource.onerror = (event) => {
    console.error("EventSource error:", event);
    eventSource.close();
  };
}


setTimeout(() => {
  testFunction();
}, 3000); // Wait a bit for the server to start before sending the request