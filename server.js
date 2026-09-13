const express = require("express");
const cors = require("cors");

const app = express();

const PORT = process.env.PORT || 3000;

// -----------------------------------------------------------------------------
// ENVIRONMENT VARIABLES
// -----------------------------------------------------------------------------

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

if (!GROQ_API_KEY) {
  console.error("ERROR: GROQ_API_KEY is not set.");
  console.error(
    "Set GROQ_API_KEY before starting the EasyTrip backend."
  );
  process.exit(1);
}

// Google Maps is optional for local startup.
// The /api/place endpoint will return a useful error if it is missing.
if (!GOOGLE_MAPS_API_KEY) {
  console.warn(
    "WARNING: GOOGLE_MAPS_API_KEY is not set. Google Places features will be unavailable."
  );
}

// -----------------------------------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------------------------------

app.use(cors());
app.use(express.json());

// -----------------------------------------------------------------------------
// HEALTH CHECK
// -----------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    message: "EasyTrip backend is running 🚀",
    status: "online",
    ai: "Groq",
    model: "openai/gpt-oss-20b",
    places: GOOGLE_MAPS_API_KEY ? "enabled" : "disabled",
  });
});

// -----------------------------------------------------------------------------
// GOOGLE PLACES SEARCH + PHOTO
// -----------------------------------------------------------------------------
//
// GET /api/place?query=India%20Gate
//
// This endpoint:
// 1. Searches Google Places (New)
// 2. Gets the best matching place
// 3. Gets its first available photo
// 4. Returns the photo URL and attribution
//
// The Google server key stays on the backend.
// -----------------------------------------------------------------------------

app.get("/api/place", async (req, res) => {
  try {
    if (!GOOGLE_MAPS_API_KEY) {
      return res.status(503).json({
        success: false,
        error:
          "Google Places is not configured on the EasyTrip server.",
      });
    }

    const query = String(req.query.query || "").trim();

    if (!query) {
      return res.status(400).json({
        success: false,
        error: "Place query is required.",
      });
    }

    // -------------------------------------------------------------------------
    // SEARCH PLACE
    // -------------------------------------------------------------------------

    const placesResponse = await fetch(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.formattedAddress,places.location,places.photos",
        },
        body: JSON.stringify({
          textQuery: query,
          languageCode: "en",
          pageSize: 1,
        }),
      }
    );

    const placesData = await placesResponse.json();

    if (!placesResponse.ok) {
      console.error(
        "PLACES SEARCH ERROR:",
        placesData
      );

      return res.status(placesResponse.status).json({
        success: false,
        error: "Unable to search Google Places.",
      });
    }

    const place = placesData.places?.[0];

    if (!place) {
      return res.status(404).json({
        success: false,
        error: "No matching place was found.",
      });
    }

    // -------------------------------------------------------------------------
    // GET PHOTO
    // -------------------------------------------------------------------------

    let photoUrl = null;
    let photoAttributions = [];

    if (
      Array.isArray(place.photos) &&
      place.photos.length > 0
    ) {
      const photoName = place.photos[0].name;

      const photoResponse = await fetch(
        `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=900&maxHeightPx=600&skipHttpRedirect=true`,
        {
          headers: {
            "X-Goog-Api-Key": GOOGLE_MAPS_API_KEY,
          },
        }
      );

      if (photoResponse.ok) {
        const photoData =
          await photoResponse.json();

        photoUrl =
          photoData.photoUri || null;
      } else {
        console.warn(
          "PLACE PHOTO ERROR:",
          photoResponse.status,
          await photoResponse.text()
        );
      }

      photoAttributions =
        place.photos[0]
          .authorAttributions || [];
    }

    // -------------------------------------------------------------------------
    // RETURN PLACE DATA
    // -------------------------------------------------------------------------

    return res.json({
      success: true,
      place: {
        id: place.id || null,

        name:
          place.displayName?.text ||
          query,

        address:
          place.formattedAddress ||
          "",

        latitude:
          place.location?.latitude ??
          null,

        longitude:
          place.location?.longitude ??
          null,

        photoUrl,

        photoAttributions,
      },
    });
  } catch (error) {
    console.error(
      "PLACE ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "Unable to load place information right now.",
    });
  }
});

// -----------------------------------------------------------------------------
// GROQ AI TRIP PLANNER
// -----------------------------------------------------------------------------

app.post("/api/plan-trip", async (req, res) => {
  try {
    const {
      from,
      destination,
      startDate,
      endDate,
      budget,
      days,
      interest,
      transport,
    } = req.body;

    // -------------------------------------------------------------------------
    // VALIDATION
    // -------------------------------------------------------------------------

    if (
      !destination ||
      !destination.trim()
    ) {
      return res.status(400).json({
        success: false,
        error: "Destination is required.",
      });
    }

    if (!startDate || !endDate) {
      return res.status(400).json({
        success: false,
        error:
          "Travel start date and end date are required.",
      });
    }

    const origin =
      from && from.trim()
        ? from.trim()
        : "Current Location";

    // -------------------------------------------------------------------------
    // CALCULATE DURATION
    // -------------------------------------------------------------------------

    let tripDuration =
      days || "Not specified";

    try {
      const start =
        new Date(startDate);

      const end =
        new Date(endDate);

      if (
        !isNaN(start.getTime()) &&
        !isNaN(end.getTime())
      ) {
        const difference =
          Math.round(
            (end - start) /
              (1000 * 60 * 60 * 24)
          ) + 1;

        if (difference > 0) {
          tripDuration =
            `${difference} day${
              difference === 1
                ? ""
                : "s"
            }`;
        }
      }
    } catch (_) {
      // Keep fallback duration.
    }

    // -------------------------------------------------------------------------
    // PROMPT
    // -------------------------------------------------------------------------

    const prompt = `
You are EasyTrip, a fast AI travel planning assistant.

Create a practical, realistic and budget-conscious travel itinerary.

TRAVEL DETAILS
--------------
Starting location: ${origin}
Destination: ${destination}
Travel start date: ${startDate}
Travel end date: ${endDate}
Trip duration: ${tripDuration}
Budget: ₹${budget || "Not specified"}
Interests: ${interest || "Everything"}
Preferred transport: ${transport || "Public Transport"}

RULES
-----
1. Plan the journey from the starting location to the destination.
2. Focus primarily on exploring the destination.
3. Respect the exact travel dates.
4. Generate exactly one itinerary object for each day in the date range.
5. Do not generate more days than the selected range.
6. Group nearby attractions together.
7. Avoid unrealistic schedules.
8. Consider the preferred transport.
9. Include useful food recommendations.
10. Include approximate costs.
11. Include practical safety advice.
12. Use approximate prices only.
13. Never invent live transport availability.
14. Never claim exact live ticket prices.
15. Never claim exact opening hours unless certain.
16. Prefer well-known tourist attractions.
17. Prefer practical and safer travel choices.
18. Mention that prices, schedules, opening hours and availability can change.

PLACE RULE
----------
Each activity must contain ONE real/common place name.

GOOD:
"India Gate"

GOOD:
"Red Fort"

BAD:
"India Gate and Red Fort"

The application will use each place name with Google Places to retrieve
location and photo information.

IMPORTANT SPEED RULE
--------------------
Keep descriptions SHORT.
Do not write long paragraphs.
Use concise useful descriptions.

RETURN ONLY VALID JSON.
NO MARKDOWN.
NO CODE FENCES.
NO EXTRA TEXT.

RETURN EXACTLY THIS STRUCTURE:

{
  "from": "string",
  "destination": "string",
  "start_date": "YYYY-MM-DD",
  "end_date": "YYYY-MM-DD",
  "duration": "string",
  "summary": "string",
  "estimated_total": "string",
  "days": [
    {
      "day": 1,
      "date": "YYYY-MM-DD",
      "title": "string",
      "activities": [
        {
          "time": "string",
          "place": "string",
          "description": "short string",
          "estimated_cost": "string"
        }
      ]
    }
  ],
  "safety_tips": [
    "short string"
  ]
}
`;

    // -------------------------------------------------------------------------
    // GROQ REQUEST
    // -----------------------------------------------------------------------------
    //
    // Groq's API is OpenAI-compatible.
    // We use JSON object mode so the Flutter app receives predictable JSON.
    // We also use low reasoning effort to reduce latency.
    // -----------------------------------------------------------------------------

    const groqResponse = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          Authorization:
            `Bearer ${GROQ_API_KEY}`,
        },

        body: JSON.stringify({
          model: "openai/gpt-oss-20b",

          messages: [
            {
              role: "system",
              content:
                "You are EasyTrip. Return only valid JSON. Keep responses concise and practical.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],

          temperature: 0.3,

          reasoning_effort: "low",

          max_completion_tokens: 5000,

          response_format: {
            type: "json_object",
          },
        }),
      }
    );

    const groqData =
      await groqResponse.json();

    // -------------------------------------------------------------------------
    // HANDLE GROQ ERROR
    // -------------------------------------------------------------------------

    if (!groqResponse.ok) {
      console.error(
        "GROQ API ERROR:",
        groqData
      );

      const groqMessage =
        groqData?.error?.message ||
        "Groq API request failed.";

      return res.status(
        groqResponse.status
      ).json({
        success: false,
        error: groqMessage,
      });
    }

    // -------------------------------------------------------------------------
    // GET MODEL TEXT
    // -------------------------------------------------------------------------

    const text =
      groqData?.choices?.[0]?.message?.content;

    if (
      !text ||
      !String(text).trim()
    ) {
      throw new Error(
        "Groq returned an empty response."
      );
    }

    // -------------------------------------------------------------------------
    // PARSE JSON
    // -------------------------------------------------------------------------

    let itinerary;

    try {
      itinerary =
        JSON.parse(
          String(text).trim()
        );
    } catch (parseError) {
      console.error(
        "GROQ RETURNED INVALID JSON:"
      );

      console.error(text);

      return res.status(500).json({
        success: false,
        error:
          "The AI returned an invalid response format.",
      });
    }

    // -------------------------------------------------------------------------
    // RETURN RESULT
    // -------------------------------------------------------------------------

    return res.status(200).json({
      success: true,
      result: itinerary,
    });
  } catch (error) {
    console.error(
      "TRIP GENERATION ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "Unable to generate the trip right now.",
    });
  }
});

// -----------------------------------------------------------------------------
// START SERVER
// -----------------------------------------------------------------------------

app.listen(
  PORT,
  "0.0.0.0",
  () => {
    console.log(
      `EasyTrip backend running on port ${PORT}`
    );

    console.log(
      "AI provider: Groq"
    );

    console.log(
      "AI model: openai/gpt-oss-20b"
    );

    if (GOOGLE_MAPS_API_KEY) {
      console.log(
        "Google Places integration is enabled."
      );
    } else {
      console.log(
        "Google Places integration is disabled."
      );
    }
  }
);