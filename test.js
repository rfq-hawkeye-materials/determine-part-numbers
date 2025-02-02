// Define the sample input
const sampleInput = {
    descriptions: ["Schedule 80 PVC Conduit 1.5 inch"]
};

// Send a POST request to your local function
async function testFunction() {
    try {
        const response = await fetch('http://localhost:8080/partNumberLookup', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(sampleInput)
        });

        const data = await response.json();
        console.log("Response from Cloud Function:", data);
    } catch (error) {
        console.error("Error sending request:", error);
    }
}

setTimeout(() => {
    testFunction();
}, 1000); // Wait a bit for the server to start before sending the request