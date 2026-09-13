const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

const GROQ_API_KEY = process.env.GROQ_API_KEY;

const OSRM_BASE_URL =
  process.env.OSRM_BASE_URL ||
  "https://router.project-osrm.org";

const NOMINATIM_URL =
  "https://nominatim.openstreetmap.org";

const WIKIMEDIA_API_URL =
  "https://commons.wikimedia.org/w/api.php";

const APP_USER_AGENT =
  "EasyTrip/1.0 (travel planning app)";

// -----------------------------------------------------------------------------
// ENVIRONMENT CHECKS
// -----------------------------------------------------------------------------

if (!GROQ_API_KEY) {
  console.error("ERROR: GROQ_API_KEY is not set.");
  console.error(
    "Set GROQ_API_KEY before starting the EasyTrip backend."
  );
  process.exit(1);
}

// -----------------------------------------------------------------------------
// MIDDLEWARE
// -----------------------------------------------------------------------------

app.use(cors());

app.use(
  express.json({
    limit: "1mb",
  })
);

// -----------------------------------------------------------------------------
// SIMPLE IN-MEMORY CACHE
// -----------------------------------------------------------------------------

const placeCache = new Map();
const photoCache = new Map();

const PLACE_CACHE_TIME = 10 * 60 * 1000;
const PHOTO_CACHE_TIME = 60 * 60 * 1000;

function getCached(cache, key, maxAge) {
  const item = cache.get(key);

  if (!item) {
    return null;
  }

  if (
    Date.now() - item.timestamp >
    maxAge
  ) {
    cache.delete(key);
    return null;
  }

  return item.value;
}

function setCached(cache, key, value) {
  cache.set(key, {
    timestamp: Date.now(),
    value,
  });
}

// -----------------------------------------------------------------------------
// HEALTH CHECK
// -----------------------------------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    message: "EasyTrip backend is running 🚀",
    status: "online",

    ai: "Groq",
    model: "openai/gpt-oss-20b",

    places: "OpenStreetMap Nominatim",

    photos: "Wikimedia Commons",

    routes: "OSRM",
  });
});

// -----------------------------------------------------------------------------
// PLACE SEARCH
// OpenStreetMap Nominatim
// -----------------------------------------------------------------------------

app.get("/api/place", async (req, res) => {
  try {
    const query = String(
      req.query.query || ""
    ).trim();

    if (!query) {
      return res.status(400).json({
        success: false,
        error: "Place query is required.",
      });
    }

    console.log(
      "PLACE SEARCH:",
      query
    );

    const normalizedQuery =
      query.toLowerCase();

    // -------------------------------------------------------------------------
    // CACHE
    // -------------------------------------------------------------------------

    const cachedPlace = getCached(
      placeCache,
      normalizedQuery,
      PLACE_CACHE_TIME
    );

    if (cachedPlace) {
      console.log(
        "PLACE CACHE HIT:",
        query
      );

      return res.json(cachedPlace);
    }

    // -------------------------------------------------------------------------
    // NOMINATIM REQUEST
    // -------------------------------------------------------------------------

    const url =
      `${NOMINATIM_URL}/search` +
      `?format=jsonv2` +
      `&q=${encodeURIComponent(query)}` +
      `&limit=1` +
      `&addressdetails=1` +
      `&accept-language=en`;

    const response =
      await fetch(url, {
        headers: {
          "User-Agent":
            APP_USER_AGENT,
          Accept:
            "application/json",
        },
      });

    const data =
      await response.json();

    if (!response.ok) {
      console.error(
        "NOMINATIM ERROR:",
        response.status,
        data
      );

      return res.status(
        response.status
      ).json({
        success: false,
        error:
          "Unable to search the place right now.",
      });
    }

    const place =
      Array.isArray(data)
        ? data[0]
        : null;

    if (!place) {
      return res.status(404).json({
        success: false,
        error:
          "No matching place was found.",
      });
    }

    const latitude =
      Number(place.lat);

    const longitude =
      Number(place.lon);

    const name =
      place.name ||
      place.display_name ||
      query;

    const address =
      place.display_name ||
      "";

    // -------------------------------------------------------------------------
    // FIND WIKIMEDIA PHOTO
    // -------------------------------------------------------------------------

    let photoInfo = null;

    try {
      photoInfo =
        await findWikimediaPhoto(
          name,
          address,
          latitude,
          longitude
        );
    } catch (photoError) {
      console.warn(
        "WIKIMEDIA PHOTO SEARCH FAILED:",
        photoError.message
      );
    }

    const result = {
      success: true,

      place: {
        id:
          place.osm_id
            ? `${place.osm_type || "osm"}-${place.osm_id}`
            : null,

        name,

        address,

        latitude:
          Number.isFinite(latitude)
            ? latitude
            : null,

        longitude:
          Number.isFinite(longitude)
            ? longitude
            : null,

        photoUrl:
          photoInfo?.photoUrl ||
          null,

        photoAttributions:
          photoInfo?.photoAttributions ||
          [],

        photoProxyUrl:
          photoInfo
            ? `/api/place-photo?query=${encodeURIComponent(
                name
              )}`
            : null,

        provider:
          "OpenStreetMap Nominatim",
      },
    };

    // -------------------------------------------------------------------------
    // CACHE
    // -------------------------------------------------------------------------

    setCached(
      placeCache,
      normalizedQuery,
      result
    );

    return res.json(result);
  } catch (error) {
    console.error(
      "PLACE ERROR:",
      error
    );

    return res.status(500).json({
      success: false,
      error:
        error?.message ||
        "Unable to load place information right now.",
    });
  }
});

// -----------------------------------------------------------------------------
// WIKIMEDIA COMMONS PHOTO SEARCH
// -----------------------------------------------------------------------------

async function findWikimediaPhoto(
  placeName,
  address,
  latitude,
  longitude
) {
  const cacheKey =
    `${placeName}|${latitude}|${longitude}`.toLowerCase();

  const cachedPhoto = getCached(
    photoCache,
    cacheKey,
    PHOTO_CACHE_TIME
  );

  if (cachedPhoto) {
    return cachedPhoto;
  }

  const searches = [
    `${placeName}`,
    `${placeName} ${address}`,
  ];

  for (const searchText of searches) {
    try {
      const params =
        new URLSearchParams({
          action: "query",
          generator: "search",

          gsrsearch:
            searchText,

          gsrnamespace: "6",

          gsrlimit: "5",

          prop:
            "imageinfo",

          iiprop:
            "url|extmetadata",

          iiurlwidth:
            "1600",

          format:
            "json",

          origin:
            "*",
        });

      const url =
        `${WIKIMEDIA_API_URL}?${params.toString()}`;

      const response =
        await fetch(url, {
          headers: {
            "User-Agent":
              APP_USER_AGENT,

            Accept:
              "application/json",
          },
        });

      if (!response.ok) {
        continue;
      }

      const data =
        await response.json();

      const pages =
        data?.query?.pages
          ? Object.values(
              data.query.pages
            )
          : [];

      for (const page of pages) {
        const imageInfo =
          page?.imageinfo?.[0];

        if (!imageInfo) {
          continue;
        }

        const photoUrl =
          imageInfo.thumburl ||
          imageInfo.url ||
          null;

        if (!photoUrl) {
          continue;
        }

        const metadata =
          imageInfo.extmetadata ||
          {};

        const artist =
          metadata.Artist?.value ||
          "";

        const license =
          metadata.LicenseShortName
            ?.value ||
          "";

        const licenseUrl =
          metadata.LicenseUrl
            ?.value ||
          "";

        const descriptionUrl =
          imageInfo.descriptionurl ||
          "";

        const result = {
          photoUrl,

          photoAttributions: [
            {
              provider:
                "Wikimedia Commons",

              artist,

              license,

              licenseUrl,

              sourceUrl:
                descriptionUrl,
            },
          ],
        };

        setCached(
          photoCache,
          cacheKey,
          result
        );

        return result;
      }
    } catch (error) {
      console.warn(
        "WIKIMEDIA SEARCH ATTEMPT FAILED:",
        error.message
      );
    }
  }

  setCached(
    photoCache,
    cacheKey,
    null
  );

  return null;
}

// -----------------------------------------------------------------------------
// PLACE PHOTO PROXY
// -----------------------------------------------------------------------------

app.get(
  "/api/place-photo",
  async (req, res) => {
    try {
      const query = String(
        req.query.query || ""
      ).trim();

      if (!query) {
        return res
          .status(400)
          .send(
            "Place query is required."
          );
      }

      console.log(
        "PLACE PHOTO REQUEST:",
        query
      );

      // -----------------------------------------------------------------------
      // SEARCH WIKIMEDIA
      // -----------------------------------------------------------------------

      const params =
        new URLSearchParams({
          action: "query",

          generator: "search",

          gsrsearch: query,

          gsrnamespace: "6",

          gsrlimit: "5",

          prop:
            "imageinfo",

          iiprop:
            "url",

          iiurlwidth:
            "1600",

          format:
            "json",

          origin:
            "*",
        });

      const searchUrl =
        `${WIKIMEDIA_API_URL}?${params.toString()}`;

      const searchResponse =
        await fetch(searchUrl, {
          headers: {
            "User-Agent":
              APP_USER_AGENT,

            Accept:
              "application/json",
          },
        });

      if (!searchResponse.ok) {
        return res
          .status(
            searchResponse.status
          )
          .send(
            "Unable to find a place photo."
          );
      }

      const searchData =
        await searchResponse.json();

      const pages =
        searchData?.query?.pages
          ? Object.values(
              searchData.query.pages
            )
          : [];

      let imageUrl = null;

      for (const page of pages) {
        const imageInfo =
          page?.imageinfo?.[0];

        if (
          imageInfo?.thumburl
        ) {
          imageUrl =
            imageInfo.thumburl;

          break;
        }

        if (
          imageInfo?.url
        ) {
          imageUrl =
            imageInfo.url;

          break;
        }
      }

      if (!imageUrl) {
        return res
          .status(404)
          .send(
            "No place photo found."
          );
      }

      // -----------------------------------------------------------------------
      // FETCH IMAGE
      // -----------------------------------------------------------------------

      const imageResponse =
        await fetch(
          imageUrl,
          {
            headers: {
              "User-Agent":
                APP_USER_AGENT,
            },
          }
        );

      if (!imageResponse.ok) {
        return res
          .status(
            imageResponse.status
          )
          .send(
            "Unable to load the place photo."
          );
      }

      const contentType =
        imageResponse.headers.get(
          "content-type"
        ) ||
        "image/jpeg";

      const imageBuffer =
        Buffer.from(
          await imageResponse.arrayBuffer()
        );

      res.setHeader(
        "Content-Type",
        contentType
      );

      res.setHeader(
        "Cache-Control",
        "public, max-age=86400, s-maxage=86400"
      );

      return res
        .status(200)
        .send(imageBuffer);
    } catch (error) {
      console.error(
        "PLACE PHOTO PROXY ERROR:",
        error
      );

      return res
        .status(500)
        .send(
          error?.message ||
            "Unable to load the place photo."
        );
    }
  }
);

// -----------------------------------------------------------------------------
// OSRM ROAD ROUTING
// -----------------------------------------------------------------------------

app.post(
  "/api/route",
  async (req, res) => {
    try {
      const {
        origin,
        destination,
        mode,
      } = req.body || {};

      const originLat =
        Number(
          origin?.latitude
        );

      const originLng =
        Number(
          origin?.longitude
        );

      const destinationLat =
        Number(
          destination?.latitude
        );

      const destinationLng =
        Number(
          destination?.longitude
        );

      if (
        !Number.isFinite(
          originLat
        ) ||
        !Number.isFinite(
          originLng
        ) ||
        !Number.isFinite(
          destinationLat
        ) ||
        !Number.isFinite(
          destinationLng
        )
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Valid origin and destination coordinates are required.",
          });
      }

      const selectedMode =
        String(
          mode ||
            "driving"
        )
          .trim()
          .toLowerCase();

      if (
        selectedMode !==
        "driving"
      ) {
        return res
          .status(400)
          .json({
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
        routeData.code !==
          "Ok"
      ) {
        console.error(
          "OSRM ROUTE ERROR:",
          routeData
        );

        return res
          .status(502)
          .json({
            success: false,
            error:
              routeData?.message ||
              "Unable to calculate the road route.",
          });
      }

      const route =
        routeData.routes?.[0];

      if (
        !route ||
        !route.geometry
      ) {
        return res
          .status(404)
          .json({
            success: false,
            error:
              "No road route was returned.",
          });
      }

      const distanceMeters =
        Number(
          route.distance
        );

      const durationSeconds =
        Number(
          route.duration
        );

      return res
        .status(200)
        .json({
          success: true,

          distanceMeters:
            Number.isFinite(
              distanceMeters
            )
              ? distanceMeters
              : null,

          duration:
            Number.isFinite(
              durationSeconds
            )
              ? `${Math.round(
                  durationSeconds
                )}s`
              : null,

          polyline:
            route.geometry,

          mode:
            "driving",

          provider:
            "OSRM",
        });
    } catch (error) {
      console.error(
        "ROUTE ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            "Unable to calculate the road route right now.",
        });
    }
  }
);

// -----------------------------------------------------------------------------
// AI TRIP PLANNER - GROQ
// -----------------------------------------------------------------------------

app.post(
  "/api/plan-trip",
  async (req, res) => {
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
        !String(
          destination
        ).trim()
      ) {
        return res
          .status(400)
          .json({
            success: false,
            error:
              "Destination is required.",
          });
      }

      if (
        !startDate ||
        !endDate
      ) {
        return res
          .status(400)
          .json({
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

      let tripDuration =
        days ||
        "Not specified";

      try {
        const start =
          new Date(
            startDate
          );

        const end =
          new Date(
            endDate
          );

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
                (1000 *
                  60 *
                  60 *
                  24)
            ) + 1;

          if (
            difference >
            0
          ) {
            tripDuration =
              `${difference} day${
                difference ===
                1
                  ? ""
                  : "s"
              }`;
          }
        }
      } catch (_) {}

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

The application uses each place name with OpenStreetMap
to retrieve location information and Wikimedia Commons
to retrieve an available photo.

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

      const groqResponse =
        await fetch(
          "https://api.groq.com/openai/v1/chat/completions",
          {
            method:
              "POST",

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
                  role:
                    "system",

                  content:
                    "You are EasyTrip. Return only valid JSON. Keep responses concise, realistic and practical.",
                },

                {
                  role:
                    "user",

                  content:
                    prompt,
                },
              ],

              temperature:
                0.3,

              reasoning_effort:
                "low",

              max_completion_tokens:
                5000,

              response_format: {
                type:
                  "json_object",
              },
            }),
          }
        );

      const groqData =
        await groqResponse.json();

      if (
        !groqResponse.ok
      ) {
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
              groqData?.error
                ?.message ||
              "Groq API request failed.",
          });
      }

      const text =
        groqData?.choices?.[0]
          ?.message?.content;

      if (
        !text ||
        !String(
          text
        ).trim()
      ) {
        throw new Error(
          "Groq returned an empty response."
        );
      }

      let itinerary;

      try {
        itinerary =
          JSON.parse(
            String(
              text
            ).trim()
          );
      } catch (parseError) {
        console.error(
          "GROQ RETURNED INVALID JSON:",
          parseError
        );

        console.error(
          text
        );

        return res
          .status(500)
          .json({
            success: false,
            error:
              "The AI returned an invalid response format.",
          });
      }

      return res
        .status(200)
        .json({
          success: true,
          result:
            itinerary,
        });
    } catch (error) {
      console.error(
        "TRIP GENERATION ERROR:",
        error
      );

      return res
        .status(500)
        .json({
          success: false,
          error:
            "Unable to generate the trip right now.",
        });
    }
  }
);

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
      "Place provider: OpenStreetMap Nominatim"
    );

    console.log(
      "Photo provider: Wikimedia Commons"
    );

    console.log(
      "Route provider: OSRM"
    );

    console.log(
      `OSRM server: ${OSRM_BASE_URL}`
    );
  }
);