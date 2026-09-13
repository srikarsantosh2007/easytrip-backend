const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

const OSRM_BASE_URL =
  process.env.OSRM_BASE_URL ||
  "https://router.project-osrm.org";

if (!GROQ_API_KEY) {
  console.error("ERROR: GROQ_API_KEY is not set.");
  console.error(
    "Set GROQ_API_KEY before starting the EasyTrip backend."
  );
  process.exit(1);
}

if (!GOOGLE_MAPS_API_KEY) {
  console.warn(
    "WARNING: GOOGLE_MAPS_API_KEY is not set. Google Places features will be unavailable."
  );
}

app.use(cors());
app.use(express.json({ limit: "1mb" }));

// -----------------------------------------------------------------------------
// HEALTH CHECK
// -----------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    message: "EasyTrip backend is running 🚀",
    status: "online",
    ai: "Groq",
    model: "openai/gpt-oss-20b",
    places: GOOGLE_MAPS_API_KEY
      ? "enabled"
      : "disabled",
    routes: "OSRM",
  });
});

// -----------------------------------------------------------------------------
// GOOGLE PLACES SEARCH + PHOTO
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

    const query = String(
      req.query.query || ""
    ).trim();

    if (!query) {
      return res.status(400).json({
        success: false,
        error: "Place query is required.",
      });
    }

    const placesResponse = await fetch(
      "https://places.googleapis.com/v1/places:searchText",
      {
        method: "POST",

        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key":
            GOOGLE_MAPS_API_KEY,
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

    const placesData =
      await placesResponse.json();

    if (!placesResponse.ok) {
      console.error(
        "PLACES SEARCH ERROR:",
        placesData
      );

      return res
        .status(placesResponse.status)
        .json({
          success: false,
          error:
            "Unable to search Google Places.",
        });
    }

    const place =
      placesData.places?.[0];

    if (!place) {
      return res.status(404).json({
        success: false,
        error:
          "No matching place was found.",
      });
    }

    let photoUrl = null;
    let photoAttributions = [];

    if (
      Array.isArray(place.photos) &&
      place.photos.length > 0
    ) {
      const photoName =
        place.photos[0].name;

      const photoResponse =
        await fetch(
          `https://places.googleapis.com/v1/${photoName}/media?maxWidthPx=1200&maxHeightPx=800&skipHttpRedirect=true`,
          {
            headers: {
              "X-Goog-Api-Key":
                GOOGLE_MAPS_API_KEY,
            },
          }
        );

      if (photoResponse.ok) {
        const photoData =
          await photoResponse.json();

        photoUrl =
          photoData.photoUri ||
          null;
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
// OSRM ROAD ROUTING
// -----------------------------------------------------------------------------
//
// This endpoint intentionally uses OSRM instead of Google Routes so that
// EasyTrip can draw real road geometry without depending on Google Routes
// billing/permissions.
//
// Response format remains compatible with the Flutter app:
//
// {
//   success: true,
//   distanceMeters: 123,
//   duration: "123s",
//   polyline: "encoded polyline"
// }
//
// OSRM's public router is primarily used here for driving routes.
// Walking/transit can fall back to Google Maps from the Flutter UI.
// -----------------------------------------------------------------------------

app.post("/api/route", async (req, res) => {
  try {
    const {
      origin,
      destination,
      mode,
    } = req.body || {};

    const originLat =
      Number(origin?.latitude);

    const originLng =
      Number(origin?.longitude);

    const destinationLat =
      Number(destination?.latitude);

    const destinationLng =
      Number(destination?.longitude);

    if (
      !Number.isFinite(originLat) ||
      !Number.isFinite(originLng) ||
      !Number.isFinite(destinationLat) ||
      !Number.isFinite(destinationLng)
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Valid origin and destination coordinates are required.",
      });
    }

    const selectedMode =
      String(mode || "driving")
        .trim()
        .toLowerCase();

    if (selectedMode !== "driving") {
      return res.status(400).json({
        success: false,
        error:
          "Live in-app road routing currently supports driving. Use Google Maps for walking or transit navigation.",
      });
    }

    const coordinates =
      `${originLng},${originLat};${destinationLng},${destinationLat}`;

    const url =
      `${OSRM_BASE_URL}/route/v1/driving/${coordinates}` +
      "?overview=full" +
      "&geometries=polyline" +
      "&steps=false" +
      "&alternatives=false";

    console.log(
      "OSRM ROUTE REQUEST:",
      url
    );

    const routeResponse =
      await fetch(url);

    const routeData =
      await routeResponse.json();

    if (
      !routeResponse.ok ||
      routeData.code !== "Ok"
    ) {
      console.error(
        "OSRM ROUTE ERROR:",
        routeData
      );

      return res.status(502).json({
        success: false,
        error:
          routeData?.message ||
          "Unable to calculate the road route.",
      });
    }

    const route =
      routeData.routes?.[0];

    if (!route) {
      return res.status(404).json({
        success: false,
        error:
          "No road route was returned.",
      });
    }

    const encodedPolyline =
      route.geometry;

    if (
      !encodedPolyline ||
      String(encodedPolyline).trim() === ""
    ) {
      return res.status(404).json({
        success: false,
        error:
          "The routing service returned no route geometry.",
      });
    }

    const distanceMeters =
      Number(route.distance);

    const durationSeconds =
      Number(route.duration);

    return res.status(200).json({
      success: true,

      distanceMeters:
        Number.isFinite(distanceMeters)
          ? distanceMeters
          : null,

      duration:
        Number.isFinite(durationSeconds)
          ? `${Math.round(
              durationSeconds
            )}s`
          : null,

      polyline:
        encodedPolyline,

      mode: "driving",

      provider: "OSRM",
    });
  } catch (error) {
    console.error(
      "ROUTE ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        "Unable to calculate the road route right now.",
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

    if (
      !destination ||
      !String(destination).trim()
    ) {
      return res.status(400).json({
        success: false,
        error:
          "Destination is required.",
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
      from &&
      String(from).trim()
        ? String(from).trim()
        : "Current Location";

    // ---------------------------------------------------------------------------
    // CALCULATE DURATION
    // ---------------------------------------------------------------------------

    let tripDuration =
      days || "Not specified";

    try {
      const start =
        new Date(startDate);

      const end =
        new Date(endDate);

      if (
        !Number.isNaN(
          start.getTime()
        ) &&
        !Number.isNaN(
          end.getTime()
        )
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

    // ---------------------------------------------------------------------------
    // GROQ PROMPT
    // ---------------------------------------------------------------------------

    const prompt = `
You are EasyTrip, a fast premium AI travel planning assistant.

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

The application uses each place name with Google Places to retrieve
location and photo information.

IMPORTANT SPEED RULE
--------------------
Keep descriptions SHORT.
Do not write long paragraphs.
Use concise useful descriptions.

IMPORTANT QUALITY RULE
----------------------
Make the itinerary feel premium and personalized.
Avoid generic filler.
Choose attractions that make geographic sense together.

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

    // ---------------------------------------------------------------------------
    // GROQ REQUEST
    // ---------------------------------------------------------------------------

    const groqResponse =
      await fetch(
        "https://api.groq.com/openai/v1/chat/completions",
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            Authorization:
              `Bearer ${GROQ_API_KEY}`,
          },

          body: JSON.stringify({
            model:
              "openai/gpt-oss-20b",

            messages: [
              {
                role: "system",

                content:
                  "You are EasyTrip. Return only valid JSON. Keep responses concise, realistic and practical.",
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

    // ---------------------------------------------------------------------------
    // GROQ ERROR
    // ---------------------------------------------------------------------------

    if (!groqResponse.ok) {
      console.error(
        "GROQ API ERROR:",
        groqData
      );

      return res
        .status(
          groqResponse.status
        )
        .json({
          success: false,
          error:
            groqData?.error?.message ||
            "Groq API request failed.",
        });
    }

    // ---------------------------------------------------------------------------
    // GET MODEL TEXT
    // ---------------------------------------------------------------------------

    const text =
      groqData?.choices?.[0]
        ?.message?.content;

    if (
      !text ||
      !String(text).trim()
    ) {
      throw new Error(
        "Groq returned an empty response."
      );
    }

    // ---------------------------------------------------------------------------
    // PARSE JSON
    // ---------------------------------------------------------------------------

    let itinerary;

    try {
      itinerary =
        JSON.parse(
          String(text).trim()
        );
    } catch (parseError) {
      console.error(
        "GROQ RETURNED INVALID JSON:",
        parseError
      );

      console.error(text);

      return res.status(500).json({
        success: false,
        error:
          "The AI returned an invalid response format.",
      });
    }

    // ---------------------------------------------------------------------------
    // RETURN RESULT
    // ---------------------------------------------------------------------------

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

    console.log(
      `Google Places integration is ${
        GOOGLE_MAPS_API_KEY
          ? "enabled"
          : "disabled"
      }.`
    );

    console.log(
      `Route provider: OSRM`
    );

    console.log(
      `OSRM server: ${OSRM_BASE_URL}`
    );
  }
);