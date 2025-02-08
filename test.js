// Define the sample input
const sampleInput = {
    descriptions: [
        `100 - feet of 1" LT conduit`,
        `50 - 1" straight LT connectors`,
        `50 - 1" 90 degree LT connectors`,
        `50 - 1" LB conduit bodies`,
        `200 - 1" to 3/4 threaded reducing bushings`,
        `4 - rolls of duct tape`,
        `50 - 2 gang bell boxes with 1" threaded hubs`,
        `4 - 1 5/8 hole saw With arbor and pilot bit`,
        `1 - 5 gallon bucket of wire lube`,
        `1 - 12" long x 1/4 metal drill bit`,
        `100 - 3/4 RT EMT couplings`,
        `100 - 3/4 RT EMT connectors`,
        `100 - Drywall anchors WDK8`,
        `200  - 1.5" strut straps`,
        `400 - 1" one hole straps`,
        `400 - 3/4 one hole straps`,
        `200 - 3/8 square washers`,
        `200 - 2" strut straps`,
        `50 - 2 gang bell box blank covers`,
    ]
};

// Send a POST request to your local function
async function testFunction() {
    try {
        const response = await fetch('http://localhost:8080/getPartNumbers', {
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