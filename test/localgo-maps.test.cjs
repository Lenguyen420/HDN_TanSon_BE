const test = require("node:test");
const assert = require("node:assert/strict");

test("Google Maps resolves explicit pins before camera coordinates and supports query links", async () => {
  const { resolveLocalGoMap } = await import("../src/services/localgoMaps.js");
  const noFetch = () => {
    throw Error("Explicit coordinates must not fetch Google");
  };
  for (const url of [
    "https://www.google.com/maps/place/Test/@11,107,15z/data=!4m2!3d10.815!4d106.63",
    "https://maps.google.com/?q=10.815,106.63",
    "https://www.google.com/maps/search/?api=1&query=10.815%2C106.63",
    "https://www.google.com/maps/@10.815,106.63,15z",
    "https://www.google.com/maps/dir/?api=1&destination=10.815,106.63",
  ])
    assert.deepEqual(await resolveLocalGoMap(url, noFetch), {
      latitude: 10.815,
      longitude: 106.63,
    });
});

test("short Maps links follow only allowed Google Maps redirects", async () => {
  const { resolveLocalGoMap } = await import("../src/services/localgoMaps.js");
  const seen = [];
  const point = await resolveLocalGoMap(
    "https://maps.app.goo.gl/test",
    async (url, options) => {
      seen.push(url);
      assert.equal(options.redirect, "manual");
      return new Response(null, {
        status: 302,
        headers: {
          Location:
            "https://www.google.com/maps/place/Test/data=!3d10.815!4d106.63",
        },
      });
    },
  );
  assert.deepEqual(point, { latitude: 10.815, longitude: 106.63 });
  assert.equal(seen.length, 1);
  for (const target of [
    "https://127.0.0.1/private",
    "http://maps.google.com/",
    "https://www.google.com.evil.test/maps",
    "https://www.google.com:444/maps",
    "https://example.com/",
  ]) {
    await assert.rejects(
      resolveLocalGoMap(
        "https://maps.app.goo.gl/test",
        async () =>
          new Response(null, { status: 302, headers: { Location: target } }),
      ),
      (error) => error.status === 400,
    );
  }
});

test("invalid coordinates, unsafe URLs, unavailable Google and address-only links fail clearly", async () => {
  const { resolveLocalGoMap } = await import("../src/services/localgoMaps.js");
  for (const url of [
    "https://localhost/",
    "https://google.com.evil.test/maps",
    "https://user:pass@maps.google.com/",
    "https://www.google.com/maps?q=91,106",
    "https://www.google.com/maps?q=10,181",
    "https://www.google.com/maps/%ZZ",
  ]) {
    await assert.rejects(
      resolveLocalGoMap(url, () => {
        throw Error("Must not fetch");
      }),
      (error) => error.status === 400,
    );
  }
  await assert.rejects(
    resolveLocalGoMap(
      "https://www.google.com/maps/place/Name",
      async () => new Response(""),
    ),
    (error) => error.status === 400,
  );
  await assert.rejects(
    resolveLocalGoMap("https://maps.app.goo.gl/test", async () => {
      throw Error("Network down");
    }),
    (error) => error.status === 502,
  );
  let count = 0;
  await assert.rejects(
    resolveLocalGoMap("https://maps.app.goo.gl/test", async () => {
      count++;
      return new Response(null, {
        status: 302,
        headers: { Location: "https://maps.app.goo.gl/test" },
      });
    }),
    (error) => error.status === 400,
  );
  assert.equal(count, 6);
});
