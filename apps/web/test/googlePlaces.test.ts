import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkGooglePlaces, googlePlace, googlePlacesKey, googleSuggest, placesProblem } from "../src/features/measure/googlePlaces";

describe("address suggestions from Google", () => {
  beforeEach(() => {
    vi.stubGlobal("location", { origin: "https://crew.example.com" });
    vi.stubGlobal("navigator", { language: "en-US" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is on only with the company's own key and the switch on", () => {
    expect(googlePlacesKey({ maps: { google_key: "AIzaOwn", google_places: true } })).toBe("AIzaOwn");
    expect(googlePlacesKey({ maps: { google_key: "AIzaOwn" } })).toBeNull();
    expect(googlePlacesKey({ maps: { google_places: true } })).toBeNull();
    expect(googlePlacesKey(null)).toBeNull();
  });

  it("asks near the map in one session, and reads the suggestions like the free ones", async () => {
    const fetch = vi.fn(async () =>
      Response.json({
        suggestions: [
          { placePrediction: { placeId: "a1", structuredFormat: { mainText: { text: "123 Main St" }, secondaryText: { text: "Rocky Mount, VA, USA" } }, types: ["street_address", "geocode"] } },
          { placePrediction: { placeId: "b2", structuredFormat: { mainText: { text: "Main St" }, secondaryText: { text: "Rocky Mount, VA, USA" } }, types: ["route"] } },
          { placePrediction: { placeId: "c3", structuredFormat: { mainText: { text: "Main Street Park" }, secondaryText: { text: "Ottawa, ON, Canada" } }, types: ["park", "establishment"] } },
          { queryPrediction: { text: { text: "main street" } } },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const found = await googleSuggest("AIzaOwn", "123 main", { lat: 37, lng: -79.9 }, "session-1");
    expect(found).toEqual([
      { placeId: "a1", label: "123 Main St", detail: "Rocky Mount, VA", kind: "address" },
      { placeId: "b2", label: "Main St", detail: "Rocky Mount, VA", kind: "street" },
      { placeId: "c3", label: "Main Street Park", detail: "Ottawa, ON, Canada", kind: "place" },
    ]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://places.googleapis.com/v1/places:autocomplete");
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("AIzaOwn");
    expect(JSON.parse(init.body as string)).toEqual({
      input: "123 main",
      sessionToken: "session-1",
      languageCode: "en-US",
      locationBias: { circle: { center: { latitude: 37, longitude: -79.9 }, radius: 50_000 } },
    });
  });

  it("looks up where the picked place is, in the same session", async () => {
    const fetch = vi.fn(async () => Response.json({ location: { latitude: 37.05, longitude: -79.87 }, addressComponents: [{ shortText: "VA", types: ["administrative_area_level_1"] }, { shortText: "US", types: ["country", "political"] }] }));
    vi.stubGlobal("fetch", fetch);
    expect(await googlePlace("AIzaOwn", "a1", "session-1")).toEqual({ lat: 37.05, lng: -79.87, country: "US" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://places.googleapis.com/v1/places/a1?sessionToken=session-1");
    expect((init.headers as Record<string, string>)["X-Goog-FieldMask"]).toBe("location,addressComponents");
  });

  it("says what to fix in Google Cloud when the key can't suggest places", async () => {
    const refused = (status: number, error: object) => vi.fn(async () => Response.json({ error }, { status }));
    vi.stubGlobal("fetch", refused(403, { status: "PERMISSION_DENIED", message: "Places API (New) has not been used in project 123 before or it is disabled.", details: [{ reason: "SERVICE_DISABLED" }] }));
    expect(await checkGooglePlaces("AIzaOwn")).toMatch(/enable Places API \(New\)/);
    vi.stubGlobal("fetch", refused(403, { status: "PERMISSION_DENIED", message: "Requests to this API places.googleapis.com method google.maps.places.v1.Places.AutocompletePlaces are blocked.", details: [{ reason: "API_KEY_SERVICE_BLOCKED" }] }));
    expect(await checkGooglePlaces("AIzaOwn")).toMatch(/add Places API \(New\) to its API restrictions/);
    vi.stubGlobal("fetch", refused(403, { status: "PERMISSION_DENIED", message: "Requests from referer https://crew.example.com/ are blocked.", details: [{ reason: "API_KEY_HTTP_REFERRER_BLOCKED" }] }));
    expect(await checkGooglePlaces("AIzaOwn")).toBe("This key is limited to other websites. In Google Cloud, add https://crew.example.com to the key's website restrictions.");
    expect(placesProblem(400, { status: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key.", details: [{ reason: "API_KEY_INVALID" }] })).toMatch(/didn't accept this key/);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ suggestions: [] })));
    expect(await checkGooglePlaces("AIzaOwn")).toBeNull();
  });
});
