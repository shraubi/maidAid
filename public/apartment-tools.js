export const APARTMENT_STORAGE_KEY = "maidaid:selected-apartment";

const GOOGLE_MAPS_HOSTS = new Set(["google.com", "www.google.com", "maps.google.com", "maps.app.goo.gl", "goo.gl"]);

export function safeMapsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && GOOGLE_MAPS_HOSTS.has(url.hostname) ? url.href : null;
  } catch {
    return null;
  }
}

export function uniqueApartments(jobs = []) {
  const seen = new Set();
  const apartments = [];
  for (const job of jobs) {
    if (job?.apartmentId == null || seen.has(job.apartmentId)) continue;
    seen.add(job.apartmentId);
    apartments.push({
      id: job.apartmentId,
      name: String(job.object ?? "").trim(),
      address: typeof job.address === "string" && job.address.trim() ? job.address.trim() : null,
      mapsUrl: safeMapsUrl(job.mapsUrl),
      noteBody: typeof job.noteBody === "string" && job.noteBody.trim() ? job.noteBody : null,
    });
  }
  return apartments;
}

export function buildMapTarget(address, mapsUrl, environment = {}) {
  const query = typeof address === "string" ? address.trim() : "";
  if (!query) return null;

  const userAgent = String(environment.userAgent ?? globalThis.navigator?.userAgent ?? "");
  const maxTouchPoints = Number(environment.maxTouchPoints ?? globalThis.navigator?.maxTouchPoints ?? 0);
  const encoded = encodeURIComponent(query);

  if (/android/i.test(userAgent)) return { href: `geo:0,0?q=${encoded}`, external: false };
  if (/iPad|iPhone|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && maxTouchPoints > 1)) {
    return { href: `maps://?q=${encoded}`, external: false };
  }

  return {
    href: safeMapsUrl(mapsUrl) ?? `https://www.google.com/maps/search/?api=1&query=${encoded}`,
    external: true,
  };
}

function normalizedApartment(value) {
  if (!value || (typeof value.id !== "number" && typeof value.id !== "string")) return null;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name) return null;
  return {
    id: value.id,
    name,
    address: typeof value.address === "string" && value.address.trim() ? value.address.trim() : null,
    mapsUrl: safeMapsUrl(value.mapsUrl),
    noteBody: typeof value.noteBody === "string" && value.noteBody.trim() ? value.noteBody : null,
  };
}

export function writeSelectedApartment(storage, apartment) {
  const normalized = normalizedApartment(apartment);
  if (!normalized) return false;
  storage.setItem(APARTMENT_STORAGE_KEY, JSON.stringify(normalized));
  return true;
}

export function readSelectedApartment(storage) {
  try {
    const raw = storage.getItem(APARTMENT_STORAGE_KEY);
    return raw ? normalizedApartment(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}


