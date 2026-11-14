# LocalGo categories

All paths below are relative to `/api/v1`. Category management uses the existing admin Bearer-token authentication and write rate limiter.

| Method | Path | Body / response |
| --- | --- | --- |
| GET | `/localgo/categories` | Public `{ data: [{ code, name }] }` |
| GET | `/admin/localgo/categories` | Same list; requires admin |
| POST | `/admin/localgo/categories` | `{ code, name }`; returns 201 `{ data: { code, name } }` |
| PATCH | `/admin/localgo/categories/:code` | `{ name }`; returns `{ data: { code, name } }` |
| DELETE | `/admin/localgo/categories/:code` | No body; returns 204 |

`code` is an immutable lowercase slug, at most 100 characters: letters, numbers, and single hyphens between segments. Names are nonempty plain text, at most 120 characters. Unknown fields are rejected. Duplicate codes, including previously deleted codes, return 409. Missing/deleted categories return 404 on management operations.

Categories are stored in `localgo_categories`. Startup inserts the original 11 codes only when absent; it preserves edited names and soft-deleted categories, including on subsequent deployments. The public response shape remains compatible with existing Mini Apps. Places continue to store the category code as a string; existing places need no migration. Place create/update validates the category against MongoDB, so newly created categories work immediately. Filters accept the same slug format.

Deletion is soft and returns 409 if any nondeleted place still references the category, including hidden places. Move those places to another category or soft-delete them first. Category deletion and place assignment use transactions and touch the same category document, preventing concurrent assignments to deleted categories. MongoDB must run as a replica set or Atlas, as required by the existing transactional modules.

Deploy Backend before Admin. Admin reuses its authenticated association proxy and Axios client. This change adds no approval workflow or new public write routes.

Validation: `npm run build`; `node --test test/localgo.test.cjs` uses an isolated MongoDB replica set, including category CRUD, authorization, default compatibility, referenced-category protection, and concurrent deletion/assignment.

## Images and Google Maps links

Place create/update accepts resized JPG/PNG/WebP data URLs for `coverImage` and `images`, alongside existing URLs. Each inline image is at most 1,400,000 characters; the combined LocalGo place JSON body is limited to 3 MiB. Admin reuses ImagePicker to select/preview local files and resize before saving. The shared ImageStorage writes into `uploads/localgo` on disk or the existing GridFS image bucket on Vercel. MongoDB place documents contain image paths, never inline bytes. Failed preparations or database saves discard newly written files; updates retain unchanged references and soft deletion preserves existing files.

`POST /admin/localgo/resolve-map` accepts `{ url }` and returns `{ data: { latitude, longitude } }`. It requires admin authentication and the existing write rate limiter. Explicit place coordinates take precedence over camera coordinates. Supported links include Google Maps coordinate queries, place data and short sharing links (`maps.app.goo.gl`, `goo.gl/maps`). Short links follow at most six redirects with a 12-second total deadline. Every redirect must stay on an allowed HTTPS Google Maps host; arbitrary origins, credentials and custom ports are rejected. Address-only links or place links containing only camera coordinates return 400 with instructions to share an explicit pin; network failures return 502. No geocoding API key is required. The resolver does not save or change a place.

Admin resolves a pasted link automatically, recenters the preview on the pin, and saves GeoJSON as `[longitude, latitude]`. Manual coordinate fields remain in an optional section. Deploy Backend before Admin.
