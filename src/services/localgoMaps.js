import { BadRequestError, HttpError } from "../utils/httpError.js";

const longHosts = new Set([
  "google.com",
  "www.google.com",
  "google.com.vn",
  "www.google.com.vn",
]);
export function mapsUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestError("Liên kết Google Maps không hợp lệ.");
  }
  const allowed =
    (longHosts.has(url.hostname) && /^\/maps(?:\/|$)/.test(url.pathname)) ||
    ["maps.google.com", "maps.google.com.vn", "maps.app.goo.gl"].includes(
      url.hostname,
    ) ||
    (url.hostname === "goo.gl" && url.pathname.startsWith("/maps/"));
  if (
    !allowed ||
    url.protocol !== "https:" ||
    url.port ||
    url.username ||
    url.password ||
    value.length > 8192
  )
    throw new BadRequestError("Vui lòng dùng liên kết HTTPS của Google Maps.");
  return url;
}
function point(lat, lng) {
  const latitude = Number(lat),
    longitude = Number(lng);
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    throw new BadRequestError("Tọa độ trong link Google Maps không hợp lệ.");
  return { latitude, longitude };
}
export function coordinatesFromMaps(url) {
  let value;
  try {
    value = decodeURIComponent(url.href);
  } catch {
    throw new BadRequestError("Liên kết Google Maps không hợp lệ.");
  }
  // Place data identifies the pin; @lat,lng can be only the camera centre.
  const pin = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(value);
  if (pin) return point(pin[1], pin[2]);
  for (const key of ["query", "q", "destination", "daddr", "ll"]) {
    const pair = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/.exec(
      url.searchParams.get(key) ?? "",
    );
    if (pair) return point(pair[1], pair[2]);
  }
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)(?:,|\/|$)/.exec(value);
  if (
    at &&
    !url.pathname.includes("/place/") &&
    !url.pathname.includes("/dir/")
  )
    return point(at[1], at[2]);
  return null;
}

export async function resolveLocalGoMap(value, transport = fetch) {
  let url = mapsUrl(value);
  const direct = coordinatesFromMaps(url);
  if (direct) return direct;
  const signal = AbortSignal.timeout(12000);
  try {
    for (let redirects = 0; redirects < 6; redirects++) {
      // Validate every redirect. No arbitrary origins, credentials or ports.
      const response = await transport(url.href, {
        redirect: "manual",
        signal,
        headers: { Accept: "text/html" },
      });
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (response.status >= 300 && response.status < 400 && location) {
        url = mapsUrl(new URL(location, url).href);
        const coordinates = coordinatesFromMaps(url);
        if (coordinates) return coordinates;
        continue;
      }
      if (!response.ok)
        throw new HttpError(
          502,
          "Google Maps chưa phản hồi. Vui lòng thử lại.",
        );
      break;
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      502,
      "Không mở được liên kết Google Maps. Vui lòng dùng link đầy đủ hoặc thử lại.",
    );
  }
  throw new BadRequestError(
    "Link chưa chứa vị trí cụ thể. Hãy ghim một điểm trong Google Maps rồi sao chép link chia sẻ.",
  );
}
