const express = require("express");
const cors = require("cors");
const { GoogleGenAI } = require("@google/genai");

const app = express();

const PORT = process.env.PORT || 3000;

// -----------------------------------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------------------------------

app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// GEMINI SETUP
// -----------------------------------------------------------------------------

if (!process.env.GEMINI_API_KEY) {
  console.error("ERROR: GEMINI_API_KEY is not set.");
  console.error(
    "Set the GEMINI_API_KEY environment variable before starting the server."
  );
  process.exit(1);
}

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
});

// -----------------------------------------------------------------------------
// HEALTH CHECK
// -----------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    message: "EasyTrip AI backend is running 🚀",
    status: "online",
  });
});

// -----------------------------------------------------------------------------
// AI TRIP PLANNER
// -----------------------------------------------------------------------------

app.post("/api/plan-trip", async (req, res) => {
  try {
    const {
      destination,
      budget,
      days,
      interest,
      transport,
    } = req.body;

    // Validate destination
    if (!destination || !destination.trim()) {
      return res.status(400).json({
        success: false,
        error: "Destination is required.",
      });
    }

    const prompt = `
You are EasyTrip, an AI-powered travel planning assistant.

Create a practical, useful and budget-conscious travel itinerary based on
the user's preferences.

USER DETAILS
------------
Destination: ${destination}
Budget: ₹${budget || "Not specified"}
Duration: ${days || "Not specified"}
Interests: ${interest || "Everything"}
Preferred transport: ${transport || "Public Transport"}

YOUR TASK
---------
Create a day-by-day travel itinerary.

The itinerary should:

1. Recommend tourist attractions appropriate for the destination.
2. Match the user's interests as closely as possible.
3. Consider the user's preferred transport.
4. Keep estimated costs close to the user's budget where reasonably possible.
5. Include food recommendations.
6. Organize activities logically by time and location.
7. Avoid unrealistic travel schedules.
8. Prioritize practical and safer travel choices.
9. Include useful safety advice.
10. Clearly state that prices, transport schedules, opening hours and availability
    may change and should be verified before travel.
11. Use approximate prices only.
12. Return ONLY valid JSON.
13. Do not use Markdown.
14. Do not wrap the JSON in code fences.

RETURN EXACTLY THIS STRUCTURE:

{
  "destination": "string",
  "summary": "string",
  "estimated_total": "string",
  "days": [
    {
      "day": 1,
      "title": "string",
      "activities": [
        {
          "time": "string",
          "place": "string",
          "description": "string",
          "estimated_cost": "string"
        }
      ]
    }
  ],
  "safety_tips": [
    "string"
  ]
}
`;

    // -------------------------------------------------------------------------
    // GEMINI REQUEST
    // -------------------------------------------------------------------------

    const interaction = await ai.interactions.create({
      model: "gemini-3.6-flash",
      input: prompt,
    });

    const text = interaction.output_text;

    if (!text || !text.trim()) {
      throw new Error("Gemini returned an empty response.");
    }

    // -------------------------------------------------------------------------
    // PARSE AI JSON
    // -------------------------------------------------------------------------

    let itinerary;

    try {
      itinerary = JSON.parse(text);
    } catch (parseError) {
      console.error("Gemini returned invalid JSON:");
      console.error(text);

      return res.status(500).json({
        success: false,
        error: "The AI returned an invalid response format.",
      });
    }

    // -------------------------------------------------------------------------
    // SEND RESULT
    // -------------------------------------------------------------------------

    return res.status(200).json({
      success: true,
      result: itinerary,
    });
  } catch (error) {
    console.error("GEMINI ERROR:", error);

    return res.status(500).json({
      success: false,
      error: "Unable to generate the trip right now.",
    });
  }
});

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `EasyTrip AI backend running on port ${PORT}`
  );
});