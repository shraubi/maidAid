const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
const formatTime = (minutes) => minutes == null ? "?" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const formatHours = (minutes) => `${Number((minutes / 60).toFixed(2))} —á`;
const formatMoney = (cents) => `${(cents / 100).toFixed(2).replace(".", ",")} ‚Ç¨`;
const typeLabel = (type) => ({ independent: "–°–∞–º–æ—Å—Ç–æ—è—Ç–µ–ª—å–Ω–∞—è —É–±–æ—Ä–∫–∞", orientation: "–û–∑–Ω–∞–∫–æ–º–ª–µ–Ω–∏–µ", practice: "–ü—Ä–∞–∫—Ç–∏–∫–∞", checkin: "Check in" })[type] ?? "–¢–∏–ø –Ω–µ —É–∫–∞–∑–∞–Ω";
const kindLabel = (kind) => ({ apartment: "–ö–≤–∞—Ä—Ç–∏—Ä–∞", laundry: "–°—É—à–∫–∞", partner_restaurant: "–ü–∞—Ä—Ç–Ω—ë—Ä" })[kind] ?? "–ú–µ—Å—Ç–æ";
const mapsHref = (item) => item.mapsUrl || (item.latitude != null && item.longitude != null ? `https://www.google.com/maps/search/?api=1&query=${item.latitude},${item.longitude}` : item.address ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.address)}` : null);

async function api(url, options) {
  const response = await fetch(url, options);
  if (response.status === 204) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(body.error ?? "request_failed"); error.body = body; throw error; }
  return body;
}

let latestPreview = null;
let ledgerDays = new Map();
let editingDateIso = null;
let apartments = [];
let savedPlaces = [];
let mapItems = [];
let placesMap = null;
let pickerMap = null;
let markerLayer = null;
let productRelease = 1;
let activeRoute = "today";
let mapMode = (() => { try { return new URLSearchParams(location.search).get("view") || localStorage.getItem("maidaid:map-view") || "map"; } catch { return "map"; } })();
const today = new Date();
const calendarPeriod = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
let selectedPeriod = calendarPeriod;

function routeFromPath() {
  if (location.pathname.startsWith("/map")) return "map";
  if (location.pathname.startsWith("/ledger")) return "ledger";
  return "today";
}

async function showRoute(route, push = false) {
  activeRoute = route;
  $$(".app-view").forEach((view) => { view.hidden = view.id !== `view-${route}`; });
  $$('[data-route]').forEach((link) => {
    if (link.dataset.route === route) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
  });
  if (push) history.pushState({}, "", route === "today" ? "/today" : `/${route}`);
  if (route === "map") await loadMapItems();
  if (route === "ledger") await loadLedger();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

$$('[data-route]').forEach((link) => link.addEventListener("click", (event) => {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); showRoute(link.dataset.route, true);
}));
window.addEventListener("popstate", async () => {
  await showRoute(routeFromPath());
  const direct = location.pathname.match(/^\/map\/apartments\/(\d+)$/);
  if (direct) await openApartmentDetail(Number(direct[1]), false);
  else if ($("#place-detail-dialog").open) $("#place-detail-dialog").close();
});

function setTodayState(state) {
  $("#today-editor").hidden = state !== "editor";
  $("#today-preview").hidden = state !== "preview";
  $("#today-result").hidden = state !== "result";
}

const textarea = $("#source-text");
textarea.addEventListener("input", () => { $("#character-count").textContent = `${textarea.value.length.toLocaleString("ru-RU")} / 32 768`; });

function renderPreview(data) {
  const problems = [...data.issues.map((issue) => issue.message), ...data.unparsedLines.map((line) => `–ù–µ —Ä–∞—Å–ø–æ–∑–Ω–∞–Ω–æ: ${line}`)];
  $("#issue-list").hidden = !problems.length;
  $("#issue-list").innerHTML = problems.length ? `<strong>–ù—É–∂–Ω–æ –∏—Å–ø—Ä–∞–≤–∏—Ç—å</strong><ul>${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>` : "";
  const jobs = data.parsed.jobs.map((job, jobIndex) => {
    const expenses = data.parsed.expenses.filter((expense) => expense.jobIndex === jobIndex || (expense.jobIndex == null && expense.object === job.object));
    const timing = job.startMinutes != null && job.endMinutes != null ? `${formatTime(job.startMinutes)}‚Äì${formatTime(job.endMinutes)}` : formatHours(job.durationMinutes);
    const apartmentAction = job.apartmentId
      ? `<button class="ghost" data-preview-apartment="${job.apartmentId}" type="button">–û—Ç–∫—Ä—ã—Ç—å –∫–≤–∞—Ä—Ç–∏—Ä—É</button>`
      : productRelease >= 2 ? `<button class="ghost" data-add-unknown-apartment="${escapeHtml(job.object)}" type="button">+ –î–æ–±–∞–≤–∏—Ç—å –∫–≤–∞—Ä—Ç–∏—Ä—É</button>` : "";
    return `<article class="job"><strong>${escapeHtml(job.object)}</strong><span>${timing}</span><small>${typeLabel(job.workType)}${job.companion ? ` ¬∑ ${escapeHtml(job.companion)}` : ""}</small>${expenses.length ? `<small class="job-expenses">–†–∞—Å—Ö–æ–¥—ã: ${expenses.map((expense) => `${escapeHtml(expense.category)} ${formatMoney(expense.amountCents)}`).join(", ")}</small>` : ""}<small>${apartmentAction}</small></article>`;
  }).join("");
  const unmatched = data.parsed.expenses.filter((expense) => expense.jobIndex == null && (!expense.object || !data.parsed.jobs.some((job) => job.object === expense.object)));
  const expenses = unmatched.map((expense) => `<article class="expense"><strong>${escapeHtml(expense.category)}${expense.object ? ` ¬∑ ${escapeHtml(expense.object)}` : ""}</strong><span>${formatMoney(expense.amountCents)}</span></article>`).join("");
  $("#parsed-summary").innerHTML = `<p class="muted">${escapeHtml(data.parsed.displayDate ?? "–î–∞—Ç–∞ –Ω–µ –æ–ø—Ä–µ–¥–µ–ª–µ–Ω–∞")}</p><div class="job-list">${jobs || "<p>–†–∞–±–æ—Ç—ã –Ω–µ –Ω–∞–π–¥–µ–Ω—ã.</p>"}</div>${expenses ? `<div class="expense-list">${expenses}</div>` : ""}<div class="totals"><div class="total"><span>–í—Ä–µ–º—è</span><strong>${formatHours(data.totals.minutes)}</strong></div><div class="total"><span>–ó–∞—Ä–∞–±–æ—Ç–æ–∫</span><strong>${formatMoney(data.totals.incomeCents)}</strong></div><div class="total"><span>–†–∞—Å—Ö–æ–¥—ã</span><strong>${formatMoney(data.totals.expensesCents)}</strong></div></div>`;
  $("#confirm-button").disabled = !data.canShare;
  setTodayState("preview");
}

$("#preview-button").addEventListener("click", async () => {
  const button = $("#preview-button"); $("#request-error").hidden = true; button.disabled = true; button.textContent = "–ü—Ä–æ–≤–µ—Ä—è—é‚Ä¶";
  try { latestPreview = await api("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: textarea.value }) }); renderPreview(latestPreview); }
  catch { $("#request-error").textContent = "–ù–µ —É–¥–∞–ª–æ—Å—å –ø—Ä–æ–≤–µ—Ä–∏—Ç—å —Å–æ–æ–±—â–µ–Ω–∏–µ."; $("#request-error").hidden = false; }
  finally { button.disabled = false; button.textContent = "–ü—Ä–æ–≤–µ—Ä–∏—Ç—å"; }
});
$("#edit-button").addEventListener("click", () => { setTodayState("editor"); textarea.focus(); });
$("#result-edit").addEventListener("click", () => { setTodayState("editor"); textarea.focus(); });
$("#confirm-button").addEventListener("click", async () => {
  if (!latestPreview?.canShare) return;
  const button = $("#confirm-button"); button.disabled = true;
  try {
    const saved = await api("/api/days", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: textarea.value }) });
    latestPreview.shareText = saved.shareText; $("#share-text").textContent = saved.shareText; $("#share-status").hidden = true;
    selectedPeriod = saved.day.dateIso.slice(0, 7); setTodayState("result");
  } catch { $("#request-error").textContent = "–ù–µ —É–¥–∞–ª–æ—Å—å —Å–æ—Ö—Ä–∞–Ω–∏—Ç—å –¥–µ–Ω—å."; $("#request-error").hidden = false; setTodayState("editor"); }
  finally { button.disabled = false; }
});
$("#parsed-summary").addEventListener("click", async (event) => {
  const apartmentButton = event.target.closest("[data-preview-apartment]");
  const addButton = event.target.closest("[data-add-unknown-apartment]");
  if (apartmentButton) { await showRoute("map", true); await openApartmentDetail(Number(apartmentButton.dataset.previewApartment)); }
  if (addButton) openPlaceForm("apartment", addButton.dataset.addUnknownApartment);
});
async function copyResult() { await navigator.clipboard.writeText(latestPreview.shareText); $("#share-status").textContent = "–¢–µ–∫—Å—Ç —Å–∫–æ–ø–∏—Ä–æ–≤–∞–Ω."; $("#share-status").hidden = false; }
$("#copy-button").addEventListener("click", copyResult);
$("#share-button").addEventListener("click", async () => { if (navigator.share) { try { await navigator.share({ text: latestPreview.shareText }); return; } catch {} } await copyResult(); });

function normalizeMapItems() {
  mapItems = [
    ...apartments.map((item) => ({ ...item, itemType: "apartment", kind: "apartment", name: item.canonicalName, note: item.noteBody })),
    ...savedPlaces.map((item) => ({ ...item, itemType: "place" })),
  ];
}

async function loadMapItems(force = false) {
  if (mapItems.length && !force) { applyMapMode(); return; }
  try {
    const apartmentData = await api("/api/apartments");
    const placeData = productRelease >= 2 ? await api("/api/places") : { places: [] };
    apartments = apartmentData.apartments; savedPlaces = placeData.places; normalizeMapItems(); renderPlaceList(); renderPlacesMap(); fillApartmentSelect(); applyMapMode();
  } catch { $("#map-error").textContent = "–ù–µ —É–¥–∞–ª–æ—Å—å –∑–∞–≥—Ä—É–∑–∏—Ç—å –º–µ—Å—Ç–∞."; $("#map-error").hidden = false; }
}

function applyMapMode() {
  if (!new Set(["map", "list"]).has(mapMode)) mapMode = "map";
  $("#map-mode-map").hidden = mapMode !== "map"; $("#map-mode-list").hidden = mapMode !== "list";
  $$('[data-map-mode]').forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.mapMode === mapMode)));
  try { localStorage.setItem("maidaid:map-view", mapMode); } catch {}
  const url = new URL(location.href); url.searchParams.set("view", mapMode); history.replaceState({}, "", `${url.pathname}${url.search}`);
  if (mapMode === "map" && placesMap) setTimeout(() => placesMap.invalidateSize(), 0);
}
$$('[data-map-mode]').forEach((button) => button.addEventListener("click", () => { mapMode = button.dataset.mapMode; applyMapMode(); }));

function renderPlaceList() {
  const query = $("#place-search").value.trim().toLocaleLowerCase("ru"); const filter = $("#place-filter").value;
  const visible = mapItems.filter((item) => (filter === "all" || item.kind === filter) && (!query || [item.name, item.address, ...(item.aliases ?? [])].filter(Boolean).some((value) => String(value).toLocaleLowerCase("ru").includes(query))));
  $("#place-list").innerHTML = visible.length ? visible.map((item) => {
    const needsLocation = item.itemType === "apartment" && item.latitude == null;
    const action = needsLocation
      ? `<button class="secondary" data-locate-apartment="${item.id}" type="button">–£–∫–∞–∑–∞—Ç—å –º–µ—Å—Ç–æ</button>`
      : `<button class="secondary" data-open-item="${item.itemType}:${item.id}" type="button">–û—Ç–∫—Ä—ã—Ç—å</button>`;
    return `<article class="place-card"><div><span class="place-kind">${kindLabel(item.kind)}</span><strong>${escapeHtml(item.name)}</strong><p class="${item.latitude == null ? "missing-location" : ""}">${escapeHtml(item.address || (item.latitude == null ? "–ù—É–∂–Ω–æ —É–∫–∞–∑–∞—Ç—å –º–µ—Å—Ç–æ–ø–æ–ª–æ–∂–µ–Ω–∏–µ" : "–ö–æ–æ—Ä–¥–∏–Ω–∞—Ç—ã —Å–æ—Ö—Ä–∞–Ω–µ–Ω—ã"))}</p></div>${action}</article>`;
  }).join("") : "<p class=\"muted\">–ù–∏—á–µ–≥–æ –Ω–µ –Ω–∞–π–¥–µ–Ω–æ.</p>";
}
$("#place-search").addEventListener("input", renderPlaceList); $("#place-filter").addEventListener("change", renderPlaceList);
$("#place-list").addEventListener("click", (event) => {
  const locate = event.target.closest("[data-locate-apartment]");
  if (locate) { openEditForm(`apartment:${locate.dataset.locateApartment}`); return; }
  const button = event.target.closest("[data-open-item]"); if (button) openItemDetail(button.dataset.openItem);
});

function renderPlacesMap() {
  const host = $("#places-map");
  if (!globalThis.L) { $("#map-empty").textContent = "–ö–∞—Ä—Ç–∞ –Ω–µ –∑–∞–≥—Ä—É–∑–∏–ª–∞—Å—å. –°–ø–∏—Å–æ–∫ –º–µ—Å—Ç –ø–æ-–ø—Ä–µ–∂–Ω–µ–º—É –¥–æ—Å—Ç—É–ø–µ–Ω."; $("#map-empty").hidden = false; return; }
  if (!placesMap) {
    placesMap = L.map(host, { zoomControl: true }).setView([48.8566, 2.3522], 12);
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' }).addTo(placesMap);
  }
  if (markerLayer) markerLayer.remove(); markerLayer = L.layerGroup().addTo(placesMap);
  const located = mapItems.filter((item) => item.latitude != null && item.longitude != null);
  located.forEach((item) => {
    const color = item.kind === "apartment" ? "#173f35" : item.kind === "laundry" ? "#b76540" : "#7a526e";
    const marker = L.circleMarker([item.latitude, item.longitude], { radius: 9, weight: 3, color: "#fffdf8", fillColor: color, fillOpacity: 1 }).addTo(markerLayer);
    marker.bindTooltip(item.name); marker.on("click", () => openItemDetail(`${item.itemType}:${item.id}`));
  });
  if (located.length) { const bounds = L.latLngBounds(located.map((item) => [item.latitude, item.longitude])); placesMap.fitBounds(bounds, { padding: [35, 35], maxZoom: 15 }); }
  $("#map-empty").hidden = located.length > 0; $("#map-empty").textContent = located.length ? "" : "–ü–æ–∫–∞ –Ω–∏ —É –æ–¥–Ω–æ–π –∫–≤–∞—Ä—Ç–∏—Ä—ã –Ω–µ—Ç –∫–æ–æ—Ä–¥–∏–Ω–∞—Ç. –û—Ç–∫—Ä–æ–π—Ç–µ —Å–ø–∏—Å–æ–∫ –∏ —É–∫–∞–∂–∏—Ç–µ –º–µ—Å—Ç–æ–ø–æ–ª–æ–∂–µ–Ω–∏–µ.";
}

async function openItemDetail(key, push = true) {
  const [type, idText] = key.split(":"); const id = Number(idText);
  if (type === "apartment") return openApartmentDetail(id, push);
  const item = savedPlaces.find((place) => place.id === id); if (!item) return;
  const mapLink = mapsHref(item);
  $("#place-detail").innerHTML = `<span class="place-kind">${kindLabel(item.kind)}</span><h2>${escapeHtml(item.name)}</h2><p class="detail-address">${escapeHtml(item.address || "–ê–¥—Ä–µ—Å –Ω–µ —É–∫–∞–∑–∞–Ω")}</p>${item.note ? `<p class="detail-note">${escapeHtml(item.note)}</p>` : ""}<div class="detail-actions">${mapLink ? `<a class="primary action-link" href="${escapeHtml(mapLink)}" target="_blank" rel="noopener noreferrer">–ú–∞—Ä—à—Ä—É—Ç</a>` : ""}<button class="secondary" data-edit-item="place:${item.id}" type="button">–ò–∑–º–µ–Ω–∏—Ç—å</button><button class="ghost" data-archive-place="${item.id}" type="button">–ê—Ä—Ö–∏–≤–∏—Ä–æ–≤–∞—Ç—å</button></div>`;
  $("#place-detail-dialog").showModal();
}

async function openApartmentDetail(id, push = true) {
  try {
    const { apartment, preferredLaundry ◊_<∂âûÀk∫wµÁe¡î∞Å•ëQï·—tÄÙÅ≠ï‰πÕ¡±•–†àËà§ÏÅçΩπÕ–Å•êÄÙÅ9’µâï»°•ëQï·–§ÏÅçΩπÕ–Å•—ï¥ÄÙÅ—Â¡îÄÙÙÙÄâÖ¡Ö…—µïπ–àÄ¸ÅÖ¡Ö…—µïπ—Ãπô•πê†°ïπ—…‰§ÄÙ¯Åïπ—…‰π•êÄÙÙÙÅ•ê§ÄËÅÕÖŸïëA±ÖçïÃπô•πê†°ïπ—…‰§ÄÙ¯Åïπ—…‰π•êÄÙÙÙÅ•ê§ÏÅ•òÄ†Ö•—ï¥§Å…ï—’…∏Ï(ÄÅ…ïÕï—A±ÖçïΩ…¥†§ÏÄê†àç¡±ÖçîµôΩ…¥µ—•—±îà§π—ï·—Ωπ—ïπ–ÄÙÄãBcBﬂBÛB◊B˜B„FF0ÉBÛB◊FFB¯àÏÄê†àç¡±Öçîµïë•–µ•êà§πŸÖ±’îÄÙÅ≠ï‰ÏÄê†àç¡±Öçîµ≠•πêà§πŸÖ±’îÄÙÅ•—ï¥π≠•πêÄ¸¸ÄâÖ¡Ö…—µïπ–àÏÄê†àç¡±ÖçîµπÖµîà§πŸÖ±’îÄÙÅ•—ï¥πçÖπΩπ•çÖ±9ÖµîÄ¸¸Å•—ï¥ππÖµîÏÄê†àç¡±ÖçîµÖëë…ïÕÃà§πŸÖ±’îÄÙÅ•—ï¥πÖëë…ïÕÃÄ¸¸ÄààÏÄê†àç¡±ÖçîµµÖ¡Ãµ’…∞à§πŸÖ±’îÄÙÅ•—ï¥πµÖ¡ÕU…∞Ä¸¸ÄààÏÄê†àç¡±ÖçîµπΩ—îà§πŸÖ±’îÄÙÅ•—ï¥ππΩ—ï	Ωë‰Ä¸¸Å•—ï¥ππΩ—îÄ¸¸ÄààÏÄê†àç¡±Öçîµ±Ö—•—’ëîà§πŸÖ±’îÄÙÅ•—ï¥π±Ö—•—’ëîÄ¸¸ÄààÏÄê†àç¡±Öçîµ±Ωπù•—’ëîà§πŸÖ±’îÄÙÅ•—ï¥π±Ωπù•—’ëîÄ¸¸ÄààÏÄê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÕΩ’…çîà§πŸÖ±’îÄÙÅ•—ï¥π±ΩçÖ—•ΩπMΩ’…çîÄ¸¸ÄààÏÅ’¡ëÖ—ïA±Öçï-•πê†§ÏÄê†àç¡±ÖçîµôΩ…¥µë•Ö±Ωúà§πÕ°Ω›5ΩëÖ∞†§Ï(ÄÄê†àç¡±Öçîµ≠•πêà§πë•ÕÖâ±ïêÄÙÅ—…’îÏ)Ù((ê†àç¡•ç¨µ±ΩçÖ—•Ω∏µâ’——Ω∏à§πÖëëŸïπ—1•Õ—ïπï»†âç±•ç¨à∞Ä†§ÄÙ¯ÅÏ(ÄÄê†àççΩΩ…ë•πÖ—îµ¡•ç≠ï»à§π°•ëëï∏ÄÙÅôÖ±ÕîÏ(ÄÅ•òÄ†Öù±ΩâÖ±Q°•Ãπ0§ÅÏÄê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÕ—Ö—’Ãà§π—ï·—Ωπ—ïπ–ÄÙÄãBkB√FFB¿ÉBÀF/B«B˚FB¿ÉFB˚FBÎB‡ÉB˜B‘ÉBﬂB√BœFFBﬂB„BÔB√FF0∏àÏÅ…ï—’…∏ÏÅÙ(ÄÅÕï—Q•µïΩ’–††§ÄÙ¯ÅÏ(ÄÄÄÅ•òÄ†Ö¡•ç≠ï…5Ö¿§ÅÏÅ¡•ç≠ï…5Ö¿ÄÙÅ0πµÖ¿†â¡•ç≠ï»µµÖ¿à§πÕï—Y•ï‹°l–‡∏‡‘ÿÿ∞Ä»∏Ã‘»…t∞Äƒ»§ÏÅ0π—•±ï1ÖÂï»†â°——¡ÃËºΩ—•±îπΩ¡ïπÕ—…ïï—µÖ¿πΩ…úΩÌÈÙΩÌ·ÙΩÌÂÙπ¡πúà∞ÅÏÅÖ——…•â’—•Ω∏ËÄàôçΩ¡‰ÏÅ=¡ïπM—…ïï—5Ö¿àÅÙ§πÖëëQº°¡•ç≠ï…5Ö¿§ÏÅ¡•ç≠ï…5Ö¿πΩ∏†âç±•ç¨à∞Ä°ÏÅ±Ö—±πúÅÙ§ÄÙ¯ÅÏÄê†àç¡±Öçîµ±Ö—•—’ëîà§πŸÖ±’îÄÙÅ±Ö—±πúπ±Ö–ÏÄê†àç¡±Öçîµ±Ωπù•—’ëîà§πŸÖ±’îÄÙÅ±Ö—±πúπ±πúÏÄê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÕΩ’…çîà§πŸÖ±’îÄÙÄâ¡•∏àÏÄê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÕ—Ö—’Ãà§π—ï·—Ωπ—ïπ–ÄÙÄãBãB˚FBÎB¿ÉBÀF/B«FB√B˜B¿ÉBÀFFFB˜FF8∏àÏÅÙ§ÏÅÙ(ÄÄÄÅ¡•ç≠ï…5Ö¿π•πŸÖ±•ëÖ—ïM•Èî†§ÏÅçΩπÕ–Å±Ö–ÄÙÅ9’µâï»†ê†àç¡±Öçîµ±Ö—•—’ëîà§πŸÖ±’î§ÏÅçΩπÕ–Å±Ω∏ÄÙÅ9’µâï»†ê†àç¡±Öçîµ±Ωπù•—’ëîà§πŸÖ±’î§ÏÅ•òÄ°9’µâï»π•Õ•π•—î°±Ö–§ÄòòÅ9’µâï»π•Õ•π•—î°±Ω∏§§Å¡•ç≠ï…5Ö¿πÕï—Y•ï‹°m±Ö–∞Å±Ωπt∞Äƒÿ§Ï(ÄÅÙ∞Ä¿§Ï)Ù§Ï(ê†àçç’……ïπ–µ±ΩçÖ—•Ω∏µâ’——Ω∏à§πÖëëŸïπ—1•Õ—ïπï»†âç±•ç¨à∞Ä†§ÄÙ¯ÅÏ(ÄÅ•òÄ†ÖπÖŸ•ùÖ—Ω»πùïΩ±ΩçÖ—•Ω∏§ÅÏÄê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÕ—Ö—’Ãà§π—ï·—Ωπ—ïπ–ÄÙÄãBOB◊B˚BÔB˚BÎB√FB„F<ÉB˜B◊B”B˚FFFBˇB˜B¿∏àÏÅ…ï—’…∏ÏÅÙ(ÄÄê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÕ—Ö—’Ãà§π—ï·—Ωπ—ïπ–ÄÙÄãB{BˇFB◊B”B◊BÔF?F8ÉFB◊BÎFF'B◊B‘ÉBÛB◊FFB˚äòàÏ(ÄÅπÖŸ•ùÖ—Ω»πùïΩ±ΩçÖ—•Ω∏πùï—’……ïπ—AΩÕ•—•Ω∏†°ÏÅçΩΩ…ëÃÅÙ§ÄÙ¯ÅÏÄê†àç¡±Öçîµ±Ö—•—’ëîà§πŸÖ±’îÄÙÅçΩΩ…ëÃπ±Ö—•—’ëîÏÄê†àç¡±Öçîµ±Ωπù•—’ëîà§πŸÖ±’îÄÙÅçΩΩ…ëÃπ±Ωπù•—’ëîÏÄê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÕΩ’…çîà§πŸÖ±’îÄÙÄâùïΩ±ΩçÖ—•Ω∏àÏÄê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÖçç’…Öç‰à§πŸÖ±’îÄÙÅçΩΩ…ëÃπÖçç’…Öç‰ÏÄê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÕ—Ö—’Ãà§π—ï·—Ωπ—ïπ–ÄÙÅÉBãB◊BÎFF'B◊B‘ÉBÛB◊FFB¯ÉFB˚FFB√B˜B◊B˜B¯∞ÉFB˚FB˜B˚FFF0ÉB˚BÎB˚BÔB¯ÄëÌ5Ö—†π…Ω’πê°çΩΩ…ëÃπÖçç’…Öç‰•ÙÉBπÄÏÅÙ∞Ä†§ÄÙ¯ÅÏÄê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÕ—Ö—’Ãà§π—ï·—Ωπ—ïπ–ÄÙÄãBwB‘ÉFB”B√BÔB˚FF0ÉBˇB˚BÔFFB„FF0ÉBœB◊B˚BÔB˚BÎB√FB„F8∏ÉBsB◊FFB¯ÉBÛB˚B€B˜B¯ÉFB˚FFB√B˜B„FF0ÉB«B◊B‹ÉFB˚FBÎB‡∏àÏÅÙ∞ÅÏÅïπÖâ±ï!•ù°çç’…Öç‰ËÅ—…’î∞Å—•µïΩ’–ËÄƒ¡|¿¿¿∞ÅµÖ·•µ’µùîËÄ¿ÅÙ§Ï)Ù§Ï((ê†àç¡±ÖçîµôΩ…¥à§πÖëëŸïπ—1•Õ—ïπï»†âÕ’âµ•–à∞ÅÖÕÂπåÄ°ïŸïπ–§ÄÙ¯ÅÏ(ÄÅïŸïπ–π¡…ïŸïπ—ïôÖ’±–†§ÏÅçΩπÕ–Åï……Ω»ÄÙÄê†àç¡±ÖçîµôΩ…¥µï……Ω»à§ÏÅï……Ω»π°•ëëï∏ÄÙÅ—…’îÏ(ÄÅçΩπÕ–Å≠•πêÄÙÄê†àç¡±Öçîµ≠•πêà§πŸÖ±’îÏÅçΩπÕ–Åïë•—-ï‰ÄÙÄê†àç¡±Öçîµïë•–µ•êà§πŸÖ±’îÏÅçΩπÕ–Å±Ö—•—’ëîÄÙÄê†àç¡±Öçîµ±Ö—•—’ëîà§πŸÖ±’îÄÙÙÙÄààÄ¸Å’πëïô•πïêÄËÅ9’µâï»†ê†àç¡±Öçîµ±Ö—•—’ëîà§πŸÖ±’î§ÏÅçΩπÕ–Å±Ωπù•—’ëîÄÙÄê†àç¡±Öçîµ±Ωπù•—’ëîà§πŸÖ±’îÄÙÙÙÄààÄ¸Å’πëïô•πïêÄËÅ9’µâï»†ê†àç¡±Öçîµ±Ωπù•—’ëîà§πŸÖ±’î§Ï(ÄÅçΩπÕ–ÅçΩµµΩ∏ÄÙÅÏÅÖëë…ïÕÃËÄê†àç¡±ÖçîµÖëë…ïÕÃà§πŸÖ±’îÅÒÅπ’±∞∞ÅµÖ¡ÕU…∞ËÄê†àç¡±ÖçîµµÖ¡Ãµ’…∞à§πŸÖ±’îÅÒÅπ’±∞∞Å±Ö—•—’ëî∞Å±Ωπù•—’ëî∞Å±ΩçÖ—•ΩπMΩ’…çîËÄê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÕΩ’…çîà§πŸÖ±’îÅÒÅ’πëïô•πïê∞Å±ΩçÖ—•Ωπçç’…ÖçÂ5ï—ï…ÃËÄê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÖçç’…Öç‰à§πŸÖ±’îÄÙÙÙÄààÄ¸Å’πëïô•πïêÄËÅ9’µâï»†ê†àç¡±Öçîµ±ΩçÖ—•Ω∏µÖçç’…Öç‰à§πŸÖ±’î§ÅÙÏ(ÄÅ—…‰ÅÏ(ÄÄÄÅ•òÄ°≠•πêÄÙÙÙÄâÖ¡Ö…—µïπ–à§ÅÏ(ÄÄÄÄÄÅçΩπÕ–Å¡ÖÂ±ΩÖêÄÙÅÏÅçÖπΩπ•çÖ±9ÖµîËÄê†àç¡±ÖçîµπÖµîà§πŸÖ±’î∞ÅπΩ—ï	Ωë‰ËÄê†àç¡±ÖçîµπΩ—îà§πŸÖ±’îÅÒÅπ’±∞∞Ä∏∏πçΩµµΩ∏ÅÙÏÅ•òÄ†Öïë•—-ï‰§Å¡ÖÂ±ΩÖêπÖ±•ÖÕïÃÄÙÅmtÏ(ÄÄÄÄÄÅçΩπÕ–Åïπë¡Ω•π–ÄÙÅïë•—-ï‰Ä¸ÅÄΩÖ¡§ΩÖ¡Ö…—µïπ—ÃºëÌïë•—-ï‰πÕ¡±•–†àËà•l≈uıÄÄËÄàΩÖ¡§ΩÖ¡Ö…—µïπ—ÃàÏÅÖ›Ö•–ÅÖ¡§°ïπë¡Ω•π–∞ÅÏÅµï—°ΩêËÅïë•—-ï‰Ä¸ÄâAQ àÄËÄâA=MPà∞Å°ïÖëï…ÃËÅÏÄâçΩπ—ïπ–µ—Â¡îàËÄâÖ¡¡±•çÖ—•Ω∏Ω©ÕΩ∏àÅÙ∞ÅâΩë‰ËÅ)M=8πÕ—…•πù•ô‰°¡ÖÂ±ΩÖê§ÅÙ§Ï(ÄÄÄÅÙÅï±ÕîÅÏ(ÄÄÄÄÄÅçΩπÕ–Å¡ÖÂ±ΩÖêÄÙÅÏÅ≠•πê∞ÅπÖµîËÄê†àç¡±ÖçîµπÖµîà§πŸÖ±’î∞ÅπΩ—îËÄê†àç¡±ÖçîµπΩ—îà§πŸÖ±’îÅÒÅπ’±∞∞ÅÖ¡Ö…—µïπ—%êËÄê†àç¡±ÖçîµÖ¡Ö…—µïπ–µ±•π¨à§πŸÖ±’îÄ¸Å9’µâï»†ê†àç¡±ÖçîµÖ¡Ö…—µïπ–µ±•π¨à§πŸÖ±’î§ÄËÅ’πëïô•πïê∞Ä∏∏πçΩµµΩ∏ÅÙÏ(ÄÄÄÄÄÅçΩπÕ–Åïπë¡Ω•π–ÄÙÅïë•—-ï‰Ä¸ÅÄΩÖ¡§Ω¡±ÖçïÃºëÌïë•—-ï‰πÕ¡±•–†àËà•l≈uıÄÄËÄàΩÖ¡§Ω¡±ÖçïÃàÏÅ•òÄ°ïë•—-ï‰§Åëï±ï—îÅ¡ÖÂ±ΩÖêπÖ¡Ö…—µïπ—%êÏÅÖ›Ö•–ÅÖ¡§°ïπë¡Ω•π–∞ÅÏÅµï—°ΩêËÅïë•—-ï‰Ä¸ÄâAQ àÄËÄâA=MPà∞Å°ïÖëï…ÃËÅÏÄâçΩπ—ïπ–µ—Â¡îàËÄâÖ¡¡±•çÖ—•Ω∏Ω©ÕΩ∏àÅÙ∞ÅâΩë‰ËÅ)M=8πÕ—…•πù•ô‰°¡ÖÂ±ΩÖê§ÅÙ§Ï(ÄÄÄÅÙ(ÄÄÄÄê†àç¡±ÖçîµôΩ…¥µë•Ö±Ωúà§πç±ΩÕî†§ÏÅµÖ¡%—ïµÃÄÙÅmtÏÅÖ›Ö•–Å±ΩÖë5Ö¡%—ïµÃ°—…’î§Ï(ÄÅÙÅçÖ—ç†Ä°çÖ’ù°–§ÅÏÅï……Ω»π—ï·—Ωπ—ïπ–ÄÙÅçÖ’ù°–πµïÕÕÖùîÄÙÙÙÄâÖ¡Ö…—µïπ—}ï·•Õ—ÃàÄ¸ÄãBkBÀB√FFB„FB¿ÉFÉFB√BÎB„BÉB˜B√BﬂBÀB√B˜B„B◊BÉFB€B‘ÉFFF'B◊FFBÀFB◊F∏àÄËÄãBwB‘ÉFB”B√BÔB˚FF0ÉFB˚FFB√B˜B„FF0ÉBÛB◊FFB¯∏àÏÅï……Ω»π°•ëëï∏ÄÙÅôÖ±ÕîÏÅÙ)Ù§Ï()ÖÕÂπåÅô’πç—•Ω∏Åô•πë9ïÖ…âÂ1Ö’πë…‰°Ö¡Ö…—µïπ—%ê§ÅÏ(ÄÅçΩπÕ–Å…ïÕ’±—ÃÄÙÄê†àç±Ö’πë…‰µ…ïÕ’±—Ãà§ÏÅ…ïÕ’±—Ãπ•ππï…!Q50ÄÙÄàÒ¿Åç±ÖÕÃıpâµ’—ïëpà˚BcF'FÉB«BÔB„B€B√BÁF#B„B‘ÉBÀB√FB„B√B˜FF/äòΩ¿¯àÏÄê†àç±Ö’πë…‰µë•Ö±Ωúà§πÕ°Ω›5ΩëÖ∞†§Ï(ÄÅ—…‰ÅÏ(ÄÄÄÅçΩπÕ–ÅëÖ—ÑÄÙÅÖ›Ö•–ÅÖ¡§°ÄΩÖ¡§ΩÖ¡Ö…—µïπ—ÃºëÌÖ¡Ö…—µïπ—%ëÙΩπïÖ…â‰µ±Ö’πë…•ïÕÄ§Ï(ÄÄÄÅ…ïÕ’±—Ãπ•ππï…!Q50ÄÙÅÄëÌëÖ—Ñπ¡…ïôï……ïë1Ö’πë…‰Ä¸ÅÄÒë•ÿÅç±ÖÕÃÙâπΩ—•çîÅÕ’ççïÕÃà¯ÒÕ—…Ωπú˚BáB◊BÁFB√FÉBÀF/B«FB√B˜B¿ËΩÕ—…Ωπú¯ÄëÌïÕçÖ¡ï!—µ∞°ëÖ—Ñπ¡…ïôï……ïë1Ö’πë…‰ππÖµî•ÙΩë•ÿ˘ÄÄËÄàâÙÒë•ÿÅç±ÖÕÃÙâ±Ö’πë…‰µ±•Õ–à¯ëÌëÖ—ÑπçÖπë•ëÖ—ïÃπ±ïπù—†Ä¸ÅëÖ—ÑπçÖπë•ëÖ—ïÃπµÖ¿†°•—ï¥∞Å•πëï‡§ÄÙ¯ÅÄÒÖ…—•ç±îÅç±ÖÕÃÙâ±Ö’πë…‰µçÖ…êà¯ÒÕ—…Ωπú¯ëÌïÕçÖ¡ï!—µ∞°•—ï¥ππÖµî•ÙΩÕ—…Ωπú¯Ò¿Åç±ÖÕÃÙâµ’—ïêà¯ëÌ5Ö—†π…Ω’πê°•—ï¥πë•Õ—Öπçï5ï—ï…Ã•ÙÉBÉ
‹ÄëÌ•—ï¥πë…Âï…Ωπô•…µïêÄ¸ÄãFFF#B„BÔBÎB¿ÉB˚FBÛB◊FB◊B˜B¿ÉB»Å=M4àÄËÄãB˜B√BÔB„FB„B‘ÉFFF#B„BÔBÎB‡ÉFFB˚B„FÉBˇFB˚BÀB◊FB„FF0âÙΩ¿¯Òë•ÿÅç±ÖÕÃÙâëï—Ö•∞µÖç—•ΩπÃà¯ÒÑÅç±ÖÕÃÙâÕïçΩπëÖ…‰ÅÖç—•Ω∏µ±•π¨àÅ°…ïòÙàëÌïÕçÖ¡ï!—µ∞°•—ï¥πµÖ¡ÕU…∞•ÙàÅ—Ö…ùï–Ùâ}â±Öπ¨àÅ…ï∞ÙâπΩΩ¡ïπï»ÅπΩ…ïôï……ï»à˚B{FBÎFF/FF0ÉBÎB√FFF,ΩÑ¯Òâ’——Ω∏Åç±ÖÕÃÙâ¡…•µÖ…‰àÅëÖ—ÑµÕï±ïç–µ±Ö’πë…‰ÙàëÌ•πëï·ÙàÅ—Â¡îÙââ’——Ω∏à˚BKF/B«FB√FF0Ωâ’——Ω∏¯Ωë•ÿ¯ΩÖ…—•ç±î˘Ä§π©Ω•∏†àà§ÄËÄàÒ¿˚BÉF?B”B˚BÉB˜B„FB◊BœB¯ÉB˜B‘ÉB˜B√BÁB”B◊B˜B¯∏Ω¿¯âÙΩë•ÿ˘ÄÏ(ÄÄÄÅ…ïÕ’±—ÃπëÖ—ÖÕï–πÖ¡Ö…—µïπ—%êÄÙÅÖ¡Ö…—µïπ—%êÏÅ…ïÕ’±—Ãπ}çÖπë•ëÖ—ïÃÄÙÅëÖ—ÑπçÖπë•ëÖ—ïÃÏ(ÄÅÙÅçÖ—ç†Ä°ï……Ω»§ÅÏÅ…ïÕ’±—Ãπ•ππï…!Q50ÄÙÅÄÒ¿Åç±ÖÕÃÙâπΩ—•çîÅï……Ω»à¯ëÌï……Ω»πµïÕÕÖùîÄÙÙÙÄâÖ¡Ö…—µïπ—}±ΩçÖ—•Ωπ}…ï≈’•…ïêàÄ¸ÄãBáB˜B√FB√BÔB¿ÉFBÎB√B€B„FB‘ÉB√B”FB◊FÉB„BÔB‡ÉBÎB˚B˚FB”B„B˜B√FF,ÉBÎBÀB√FFB„FF,∏àÄËÄãBB˚B„FBËÉFFF#B◊BËÉBÀFB◊BÛB◊B˜B˜B¯ÉB˜B◊B”B˚FFFBˇB◊BÙ∏âÙΩ¿˘ÄÏÅÙ)Ù(ê†àç±Ö’πë…‰µ…ïÕ’±—Ãà§πÖëëŸïπ—1•Õ—ïπï»†âç±•ç¨à∞ÅÖÕÂπåÄ°ïŸïπ–§ÄÙ¯ÅÏ(ÄÅçΩπÕ–Åâ’——Ω∏ÄÙÅïŸïπ–π—Ö…ùï–πç±ΩÕïÕ–†âmëÖ—ÑµÕï±ïç–µ±Ö’πë…Âtà§ÏÅ•òÄ†Öâ’——Ω∏§Å…ï—’…∏Ï(ÄÅçΩπÕ–ÅçÖπë•ëÖ—îÄÙÄê†àç±Ö’πë…‰µ…ïÕ’±—Ãà§π}çÖπë•ëÖ—ïÃ¸πm9’µâï»°â’——Ω∏πëÖ—ÖÕï–πÕï±ïç—1Ö’πë…‰•tÏÅçΩπÕ–ÅÖ¡Ö…—µïπ—%êÄÙÅ9’µâï»†ê†àç±Ö’πë…‰µ…ïÕ’±—Ãà§πëÖ—ÖÕï–πÖ¡Ö…—µïπ—%ê§ÏÅ•òÄ†ÖçÖπë•ëÖ—î§Å…ï—’…∏Ï(ÄÅÖ›Ö•–ÅÖ¡§°ÄΩÖ¡§ΩÖ¡Ö…—µïπ—ÃºëÌÖ¡Ö…—µïπ—%ëÙΩ±Ö’πë…‰µ±•π≠ÕÄ∞ÅÏÅµï—°ΩêËÄâA=MPà∞Å°ïÖëï…ÃËÅÏÄâçΩπ—ïπ–µ—Â¡îàËÄâÖ¡¡±•çÖ—•Ω∏Ω©ÕΩ∏àÅÙ∞ÅâΩë‰ËÅ)M=8πÕ—…•πù•ô‰°ÏÅçÖπë•ëÖ—îËÅÏÅΩÕµQÂ¡îËÅçÖπë•ëÖ—îπΩÕµQÂ¡î∞ÅΩÕµ%êËÅçÖπë•ëÖ—îπΩÕµ%ê∞ÅπÖµîËÅçÖπë•ëÖ—îππÖµî∞ÅÖëë…ïÕÃËÅçÖπë•ëÖ—îπÖëë…ïÕÃ∞Å±Ö—•—’ëîËÅçÖπë•ëÖ—îπ±Ö—•—’ëî∞Å±Ωπù•—’ëîËÅçÖπë•ëÖ—îπ±Ωπù•—’ëîÅÙÅÙ§ÅÙ§Ï(ÄÄê†àç±Ö’πë…‰µë•Ö±Ωúà§πç±ΩÕî†§ÏÅµÖ¡%—ïµÃÄÙÅmtÏÅÖ›Ö•–Å±ΩÖë5Ö¡%—ïµÃ°—…’î§ÏÅÖ›Ö•–ÅΩ¡ïπ¡Ö…—µïπ—ï—Ö•∞°Ö¡Ö…—µïπ—%ê∞ÅôÖ±Õî§Ï)Ù§Ï()çΩπÕ–ÅôΩ…µÖ—Aï…•ΩêÄÙÄ°¡ï…•Ωê§ÄÙ¯ÅÏÅçΩπÕ–ÅmÂïÖ»∞ÅµΩπ—°tÄÙÅ¡ï…•ΩêπÕ¡±•–†à¥à§πµÖ¿°9’µâï»§ÏÅçΩπÕ–Å±Öâï∞ÄÙÅπï‹Å%π—∞πÖ—ïQ•µïΩ…µÖ–†â…‘µITà∞ÅÏÅµΩπ—†ËÄâ±Ωπúà∞ÅÂïÖ»ËÄâπ’µï…•åàÅÙ§πôΩ…µÖ–°πï‹ÅÖ—î°ÂïÖ»∞ÅµΩπ—†Ä¥Äƒ∞Äƒ§§ÏÅ…ï—’…∏Å±Öâï±l¡tπ—ΩU¡¡ï…ÖÕî†§Ä¨Å±Öâï∞πÕ±•çî†ƒ§ÏÅÙÏ)ô’πç—•Ω∏Å…ïπëï…1ïëùï»°ëÖ—Ñ§ÅÏ(ÄÅçΩπÕ–Å—Ω—Ö±ÃÄÙÅëÖ—Ñπ—Ω—Ö±ÃÏÅ±ïëùï…ÖÂÃÄÙÅπï‹Å5Ö¿°ëÖ—Ñπ…Ω›Ãπô•±—ï»†°…Ω‹§ÄÙ¯Å…Ω‹π…Ω›QÂ¡îÄÙÙÙÄâ›Ω…¨à§πµÖ¿†°…Ω‹§ÄÙ¯Åm…Ω‹πëÖ—ï%Õº∞Å…Ω›t§§Ï(ÄÄê†àç±ïëùï»µ—Ω—Ö±Ãà§π•ππï…!Q50ÄÙÅmlãBüB√FF,à∞ÅôΩ…µÖ—!Ω’…Ã°—Ω—Ö±Ãπµ•π’—ïÃ•t∞ÅlãBB˚BÔFFB◊B˜B¯à∞ÅôΩ…µÖ—5Ωπï‰°—Ω—Ö±Ãπ…ïçï•Ÿïëïπ—Ã•t∞ÅlãB{FFB√FB˚BËà∞ÅôΩ…µÖ—5Ωπï‰°—Ω—Ö±ÃπΩ’—Õ—Öπë•πùïπ—Ã•t∞ÅlãBÉB√FFB˚B”F,à∞ÅôΩ…µÖ—5Ωπï‰°—Ω—Ö±Ãπï·¡ïπÕïÕïπ—Ã•utπµÖ¿†°m±Öâï∞∞ÅŸÖ±’ït§ÄÙ¯ÅÄÒë•ÿÅç±ÖÕÃÙâÕ’µµÖ…‰µ•—ï¥à¯ÒÕ¡Ö∏¯ëÌ±Öâï±ÙΩÕ¡Ö∏¯ÒÕ—…Ωπú¯ëÌŸÖ±’ïÙΩÕ—…Ωπú¯Ωë•ÿ˘Ä§π©Ω•∏†àà§Ï(ÄÄê†àç±ïëùï»µ…Ω›Ãà§π•ππï…!Q50ÄÙÅëÖ—Ñπ…Ω›Ãπ±ïπù—†Ä¸ÅëÖ—Ñπ…Ω›ÃπµÖ¿†°…Ω‹§ÄÙ¯ÅÏ(ÄÄÄÅ•òÄ°…Ω‹π…Ω›QÂ¡îÄÙÙÙÄâ›Ω…¨à§ÅÏ(ÄÄÄÄÄÅçΩπÕ–Åëï—Ö•±ÃÄÙÄ°…Ω‹π¡Ö…Õïëï—Ö•±Ã¸π©ΩâÃÄ¸¸Åmt§πµÖ¿†°©Ωà§ÄÙ¯ÅÄÒë•ÿÅç±ÖÕÃÙâ±ïëùï»µëï—Ö•∞µ•—ï¥à¯ÒÕ—…Ωπú¯ëÌïÕçÖ¡ï!—µ∞°©ΩàπΩâ©ïç–•ÙΩÕ—…Ωπú¯ÒÕµÖ±∞¯ëÌ—Â¡ï1Öâï∞°©Ωàπ›Ω…≠QÂ¡î•ÙΩÕµÖ±∞¯Ωë•ÿ˘Ä§π©Ω•∏†àà§Ï(ÄÄÄÄÄÅ…ï—’…∏ÅÄÒÖ…—•ç±îÅç±ÖÕÃÙâ±ïëùï»µ…Ω‹à¯Ò—•µî¯ëÌïÕçÖ¡ï!—µ∞°…Ω‹πëÖ—ï%Õº•ÙΩ—•µî¯Òë•ÿ¯ÒÕ—…Ωπú¯ëÌôΩ…µÖ—!Ω’…Ã°…Ω‹πµ•π’—ïÃ•ÙÉFB√B«B˚FF,ΩÕ—…Ωπú¯Òâ»¯ÒÕµÖ±∞¯ëÌôΩ…µÖ—5Ωπï‰°…Ω‹π•πçΩµïïπ—Ã•ÙÉBﬂB√FB√B«B˚FB√B˜B¯É
‹ÄëÌôΩ…µÖ—5Ωπï‰°…Ω‹πï·¡ïπÕïÕïπ—Ã•ÙÉFB√FFB˚B”F,ΩÕµÖ±∞¯Ωë•ÿ¯Òë•ÿÅç±ÖÕÃÙâ±ïëùï»µ…Ω‹µÖç—•ΩπÃà¯Òâ’——Ω∏Åç±ÖÕÃÙâÕïçΩπëÖ…‰àÅëÖ—Ñµïë•–µëÖ‰ÙàëÌ…Ω‹πëÖ—ï%ÕΩÙà˚BcBﬂBÛB◊B˜B„FF0Ωâ’——Ω∏¯Òâ’——Ω∏Åç±ÖÕÃÙâù°ΩÕ–àÅëÖ—Ñµëï±ï—îµëÖ‰ÙàëÌ…Ω‹πëÖ—ï%ÕΩÙà˚BèB”B√BÔB„FF0Ωâ’——Ω∏¯Ωë•ÿ¯Òë•ÿÅç±ÖÕÃÙâ±ïëùï»µëÖ‰µ—ÖâÃà¯Òëï—Ö•±ÃÅç±ÖÕÃÙâ±ïëùï»µëÖ‰µëï—Ö•±Ãà¯ÒÕ’µµÖ…‰˚BÉB√FBˇB„FB√B˜B„B‘ΩÕ’µµÖ…‰¯Ò¡…î¯ëÌïÕçÖ¡ï!—µ∞°…Ω‹πÕΩ’…çïQï·–•ÙΩ¡…î¯Ωëï—Ö•±Ã¯Òëï—Ö•±ÃÅç±ÖÕÃÙâ±ïëùï»µëÖ‰µëï—Ö•±Ãà¯ÒÕ’µµÖ…‰˚B{FFFGFΩÕ’µµÖ…‰¯Ò¡…î¯ëÌïÕçÖ¡ï!—µ∞°…Ω‹π…ï¡Ω…—Qï·–ÅÒÄãB{FFFGFÉB˜B‘ÉFB˚FFB√B˜FGBÙà•ÙΩ¡…î¯Ωëï—Ö•±Ã¯Òëï—Ö•±ÃÅç±ÖÕÃÙâ±ïëùï»µëÖ‰µëï—Ö•±Ãà¯ÒÕ’µµÖ…‰˚BB˚B”FB˚B«B˜B◊B‘ΩÕ’µµÖ…‰¯Òë•ÿÅç±ÖÕÃÙâ±ïëùï»µëï—Ö•∞µ±•Õ–à¯ëÌëï—Ö•±ÃÅÒÄãBÉB√B«B˚FF,ÉB˜B‘ÉB˜B√BÁB”B◊B˜F,âÙΩë•ÿ¯Ωëï—Ö•±Ã¯Ωë•ÿ¯ΩÖ…—•ç±î˘ÄÏ(ÄÄÄÅÙ(ÄÄÄÅçΩπÕ–ÅµÖπ’Ö∞ÄÙÅ…Ω‹πÕΩ’…çîÄÙÙÙÄâµÖπ’Ö∞àÏÅ…ï—’…∏ÅÄÒÖ…—•ç±îÅç±ÖÕÃÙâ±ïëùï»µ…Ω‹à¯Ò—•µî¯ëÌ…Ω‹πëÖ—ï%ÕΩÙΩ—•µî¯Òë•ÿ¯ÒÕ—…Ωπú¯ëÌôΩ…µÖ—5Ωπï‰°…Ω‹πÖµΩ’π—ïπ—Ã•ÙÉBˇB˚BÔFFB◊B˜B¯ΩÕ—…Ωπú¯Òâ»¯ÒÕµÖ±∞¯ëÌïÕçÖ¡ï!—µ∞°…Ω‹ππΩ—îÅÒÄ°µÖπ’Ö∞Ä¸ÄãBÉFFB˜B√F<ÉB˚BˇBÔB√FB¿àÄËÄãBCBÀB√B˜FÉB„B‹ÉB˚FFFGFB¿à§•ÙΩÕµÖ±∞¯Ωë•ÿ¯ëÌµÖπ’Ö∞Ä¸ÅÄÒë•ÿÅç±ÖÕÃÙâ±ïëùï»µ…Ω‹µÖç—•ΩπÃà¯Òâ’——Ω∏Åç±ÖÕÃÙâÕïçΩπëÖ…‰àÅëÖ—Ñµïë•–µ¡ÖÂµïπ–ÙàëÌ…Ω‹π•ëÙàÅëÖ—ÑµëÖ—îÙàëÌ…Ω‹πëÖ—ï%ÕΩÙàÅëÖ—ÑµÖµΩ’π–ÙàëÌ…Ω‹πÖµΩ’π—ïπ—ÕÙàÅëÖ—ÑµπΩ—îÙàëÌïÕçÖ¡ï!—µ∞°…Ω‹ππΩ—îÅÒÄàà•Ùà˚BcBﬂBÛB◊B˜B„FF0Ωâ’——Ω∏¯Òâ’——Ω∏Åç±ÖÕÃÙâù°ΩÕ–àÅëÖ—Ñµëï±ï—îµ¡ÖÂµïπ–ÙàëÌ…Ω‹π•ëÙà˚BèB”B√BÔB„FF0Ωâ’——Ω∏¯Ωë•ÿ˘ÄÄËÄàÒÕ¡Ö∏Åç±ÖÕÃıpâµ’—ïëpà˚BcB‹ÉFB◊BÎFFB¿ΩÕ¡Ö∏¯âÙΩÖ…—•ç±î˘ÄÏ(ÄÅÙ§π©Ω•∏†àà§ÄËÄàÒ¿Åç±ÖÕÃıpâµ’—ïëpà˚B_B√BˇB„FB◊B‰ÉBˇB˚BÎB¿ÉB˜B◊F∏Ω¿¯àÏ)Ù)ÖÕÂπåÅô’πç—•Ω∏Å±ΩÖë1ïëùï»†§ÅÏÅ—…‰ÅÏÄê†àç±ïëùï»µï……Ω»à§π°•ëëï∏ÄÙÅ—…’îÏÄê†àç±ïëùï»µ¡ï…•Ωêµ±Öâï∞à§π—ï·—Ωπ—ïπ–ÄÙÅôΩ…µÖ—Aï…•Ωê°Õï±ïç—ïëAï…•Ωê§ÏÅ…ïπëï…1ïëùï»°Ö›Ö•–ÅÖ¡§°ÄΩÖ¡§Ω±ïëùï»˝ô…Ω¥ÙëÌÕï±ïç—ïëAï…•ΩëÙ¥¿ƒô—ºÙëÌÕï±ïç—ïëAï…•ΩëÙ¥Ã≈Ä§§ÏÅÙÅçÖ—ç†ÅÏÄê†àç±ïëùï»µï……Ω»à§π—ï·—Ωπ—ïπ–ÄÙÄãBwB‘ÉFB”B√BÔB˚FF0ÉBﬂB√BœFFBﬂB„FF0ÉB„FFB˚FB„F8∏àÏÄê†àç±ïëùï»µï……Ω»à§π°•ëëï∏ÄÙÅôÖ±ÕîÏÅÙÅÙ(ê†àçÖëêµ¡ÖÂµïπ–µâ’——Ω∏à§πÖëëŸïπ—1•Õ—ïπï»†âç±•ç¨à∞Ä†§ÄÙ¯Äê†àç¡ÖÂµïπ–µë•Ö±Ωúà§πÕ°Ω›5ΩëÖ∞†§§Ï(ê†àç¡ÖÂµïπ–µôΩ…¥à§πÖëëŸïπ—1•Õ—ïπï»†âÕ’âµ•–à∞ÅÖÕÂπåÄ°ïŸïπ–§ÄÙ¯ÅÏÅïŸïπ–π¡…ïŸïπ—ïôÖ’±–†§ÏÅÖ›Ö•–ÅÖ¡§†àΩÖ¡§Ω¡ÖÂµïπ—Ãà∞ÅÏÅµï—°ΩêËÄâA=MPà∞Å°ïÖëï…ÃËÅÏÄâçΩπ—ïπ–µ—Â¡îàËÄâÖ¡¡±•çÖ—•Ω∏Ω©ÕΩ∏àÅÙ∞ÅâΩë‰ËÅ)M=8πÕ—…•πù•ô‰°ÏÅëÖ—ï%ÕºËÄê†àç¡ÖÂµïπ–µëÖ—îà§πŸÖ±’î∞ÅÖµΩ’π—ïπ—ÃËÅ5Ö—†π…Ω’πê°9’µâï»†ê†àç¡ÖÂµïπ–µÖµΩ’π–à§πŸÖ±’î§Ä®Äƒ¿¿§∞ÅπΩ—îËÄê†àç¡ÖÂµïπ–µπΩ—îà§πŸÖ±’îÅÒÅ’πëïô•πïêÅÙ§ÅÙ§ÏÄê†àç¡ÖÂµïπ–µë•Ö±Ωúà§πç±ΩÕî†§ÏÄê†àç¡ÖÂµïπ–µÖµΩ’π–à§πŸÖ±’îÄÙÄààÏÄê†àç¡ÖÂµïπ–µπΩ—îà§πŸÖ±’îÄÙÄààÏÅÖ›Ö•–Å±ΩÖë1ïëùï»†§ÏÅÙ§Ï(ê†àç¡ï…•ΩëÃµâ’——Ω∏à§πÖëëŸïπ—1•Õ—ïπï»†âç±•ç¨à∞ÅÖÕÂπåÄ†§ÄÙ¯ÅÏÅçΩπÕ–ÅÏÅ¡ï…•ΩëÃÅÙÄÙÅÖ›Ö•–ÅÖ¡§†àΩÖ¡§Ω¡ï…•ΩëÃà§ÏÅçΩπÕ–ÅÖŸÖ•±Öâ±îÄÙÅl∏∏ππï‹ÅMï–°mçÖ±ïπëÖ…Aï…•Ωê∞Ä∏∏π¡ï…•ΩëÃπµÖ¿†°ÏÅ¡ï…•ΩêÅÙ§ÄÙ¯Å¡ï…•Ωê•t•tÏÄê†àç¡ï…•ΩëÃµ±•Õ–à§π•ππï…!Q50ÄÙÅÖŸÖ•±Öâ±îπµÖ¿†°¡ï…•Ωê§ÄÙ¯ÅÄÒâ’——Ω∏Åç±ÖÕÃÙàëÌ¡ï…•ΩêÄÙÙÙÅÕï±ïç—ïëAï…•ΩêÄ¸Äâ¡…•µÖ…‰àÄËÄâÕïçΩπëÖ…‰âÙàÅëÖ—Ñµ¡ï…•ΩêÙàëÌ¡ï…•ΩëÙà¯ëÌôΩ…µÖ—Aï…•Ωê°¡ï…•Ωê•ÙΩâ’——Ω∏˘Ä§π©Ω•∏†àà§ÏÄê†àç¡ï…•ΩëÃµë•Ö±Ωúà§πÕ°Ω›5ΩëÖ∞†§ÏÅÙ§Ï(ê†àç¡ï…•ΩëÃµ±•Õ–à§πÖëëŸïπ—1•Õ—ïπï»†âç±•ç¨à∞ÅÖÕÂπåÄ°ïŸïπ–§ÄÙ¯ÅÏÅçΩπÕ–Åâ’——Ω∏ÄÙÅïŸïπ–π—Ö…ùï–πç±ΩÕïÕ–†âmëÖ—Ñµ¡ï…•Ωëtà§ÏÅ•òÄ†Öâ’——Ω∏§Å…ï—’…∏ÏÅÕï±ïç—ïëAï…•ΩêÄÙÅâ’——Ω∏πëÖ—ÖÕï–π¡ï…•ΩêÏÄê†àç¡ï…•ΩëÃµë•Ö±Ωúà§πç±ΩÕî†§ÏÅÖ›Ö•–Å±ΩÖë1ïëùï»†§ÏÅÙ§Ï(ê†àç±ïëùï»µ…Ω›Ãà§πÖëëŸïπ—1•Õ—ïπï»†âç±•ç¨à∞ÅÖÕÂπåÄ°ïŸïπ–§ÄÙ¯ÅÏ(ÄÅçΩπÕ–Åïë•—Ö‰ÄÙÅïŸïπ–π—Ö…ùï–πç±ΩÕïÕ–†âmëÖ—Ñµïë•–µëÖÂtà§ÏÅçΩπÕ–Åëï±ï—ïÖ‰ÄÙÅïŸïπ–π—Ö…ùï–πç±ΩÕïÕ–†âmëÖ—Ñµëï±ï—îµëÖÂtà§ÏÅçΩπÕ–Åïë•—AÖÂµïπ–ÄÙÅïŸïπ–π—Ö…ùï–πç±ΩÕïÕ–†âmëÖ—Ñµïë•–µ¡ÖÂµïπ—tà§ÏÅçΩπÕ–Åëï±ï—ïAÖÂµïπ–ÄÙÅïŸïπ–π—Ö…ùï–πç±ΩÕïÕ–†âmëÖ—Ñµëï±ï—îµ¡ÖÂµïπ—tà§Ï(ÄÅ•òÄ°ïë•—Ö‰§ÅÏÅçΩπÕ–ÅëÖ‰ÄÙÅ±ïëùï…ÖÂÃπùï–°ïë•—Ö‰πëÖ—ÖÕï–πïë•—Ö‰§ÏÅ•òÄ°ëÖ‰§ÅÏÅïë•—•πùÖ—ï%ÕºÄÙÅëÖ‰πëÖ—ï%ÕºÏÄê†àçëÖ‰µïë•–µëÖ—îà§π—ï·—Ωπ—ïπ–ÄÙÅëÖ‰πëÖ—ï%ÕºÏÄê†àçëÖ‰µïë•–µ—ï·–à§πŸÖ±’îÄÙÅëÖ‰πÕΩ’…çïQï·–ÏÄê†àçëÖ‰µïë•–µë•Ö±Ωúà§πÕ°Ω›5ΩëÖ∞†§ÏÅÙÅÙ(ÄÅ•òÄ°ëï±ï—ïÖ‰ÄòòÅçΩπô•…¥°ÉBèB”B√BÔB„FF0ÉFB√B«B˚FB„B‰ÉB”B◊B˜F0ÄëÌëï±ï—ïÖ‰πëÖ—ÖÕï–πëï±ï—ïÖÂÙ˝Ä§§ÅÏÅÖ›Ö•–ÅÖ¡§°ÄΩÖ¡§ΩëÖÂÃºëÌëï±ï—ïÖ‰πëÖ—ÖÕï–πëï±ï—ïÖÂıÄ∞ÅÏÅµï—°ΩêËÄâ1QàÅÙ§ÏÅÖ›Ö•–Å±ΩÖë1ïëùï»†§ÏÅÙ(ÄÅ•òÄ°ëï±ï—ïAÖÂµïπ–ÄòòÅçΩπô•…¥†ãBèB”B√BÔB„FF0ÉF7FFÉB˚BˇBÔB√FF¸à§§ÅÏÅÖ›Ö•–ÅÖ¡§°ÄΩÖ¡§Ω¡ÖÂµïπ—ÃºëÌëï±ï—ïAÖÂµïπ–πëÖ—ÖÕï–πëï±ï—ïAÖÂµïπ—ıÄ∞ÅÏÅµï—°ΩêËÄâ1QàÅÙ§ÏÅÖ›Ö•–Å±ΩÖë1ïëùï»†§ÏÅÙ(ÄÅ•òÄ°ïë•—AÖÂµïπ–§ÅÏÅçΩπÕ–ÅëÖ—ï%ÕºÄÙÅ¡…Ωµ¡–†ãBSB√FB¿ÉB˚BˇBÔB√FF,Ëà∞Åïë•—AÖÂµïπ–πëÖ—ÖÕï–πëÖ—î§ÏÅ•òÄ°ëÖ—ï%ÕºÄÙÙÅπ’±∞§Å…ï—’…∏ÏÅçΩπÕ–ÅÖµΩ’π–ÄÙÅ¡…Ωµ¡–†ãBáFBÛBÛB¿ÉB»ÉB◊BÀFB¯Ëà∞ÅM—…•πú°9’µâï»°ïë•—AÖÂµïπ–πëÖ—ÖÕï–πÖµΩ’π–§ÄºÄƒ¿¿§§ÏÅ•òÄ°ÖµΩ’π–ÄÙÙÅπ’±∞§Å…ï—’…∏ÏÅçΩπÕ–ÅπΩ—îÄÙÅ¡…Ωµ¡–†ãBFB„BÛB◊FB√B˜B„B‘Ëà∞Åïë•—AÖÂµïπ–πëÖ—ÖÕï–ππΩ—î§ÏÅ•òÄ°πΩ—îÄÙÙÅπ’±∞§Å…ï—’…∏ÏÅÖ›Ö•–ÅÖ¡§°ÄΩÖ¡§Ω¡ÖÂµïπ—ÃºëÌïë•—AÖÂµïπ–πëÖ—ÖÕï–πïë•—AÖÂµïπ—ıÄ∞ÅÏÅµï—°ΩêËÄâAQ à∞Å°ïÖëï…ÃËÅÏÄâçΩπ—ïπ–µ—Â¡îàËÄâÖ¡¡±•çÖ—•Ω∏Ω©ÕΩ∏àÅÙ∞ÅâΩë‰ËÅ)M=8πÕ—…•πù•ô‰°ÏÅëÖ—ï%Õº∞ÅÖµΩ’π—ïπ—ÃËÅ5Ö—†π…Ω’πê°9’µâï»°ÖµΩ’π–π…ï¡±Öçî†à∞à∞Äà∏à§§Ä®Äƒ¿¿§∞ÅπΩ—îÅÙ§ÅÙ§ÏÅÖ›Ö•–Å±ΩÖë1ïëùï»†§ÏÅÙ)Ù§Ï(ê†àçëÖ‰µïë•–µôΩ…¥à§πÖëëŸïπ—1•Õ—ïπï»†âÕ’âµ•–à∞ÅÖÕÂπåÄ°ïŸïπ–§ÄÙ¯ÅÏÅïŸïπ–π¡…ïŸïπ—ïôÖ’±–†§ÏÅçΩπÕ–Å—ï·–ÄÙÄê†àçëÖ‰µïë•–µ—ï·–à§πŸÖ±’îÏÅçΩπÕ–Å¡…ïŸ•ï‹ÄÙÅÖ›Ö•–ÅÖ¡§†àΩÖ¡§Ω¡…ïŸ•ï‹à∞ÅÏÅµï—°ΩêËÄâA=MPà∞Å°ïÖëï…ÃËÅÏÄâçΩπ—ïπ–µ—Â¡îàËÄâÖ¡¡±•çÖ—•Ω∏Ω©ÕΩ∏àÅÙ∞ÅâΩë‰ËÅ)M=8πÕ—…•πù•ô‰°ÏÅ—ï·–ÅÙ§ÅÙ§ÏÅ•òÄ†Ö¡…ïŸ•ï‹πçÖπM°Ö…îÅÒÅ¡…ïŸ•ï‹π¡Ö…ÕïêπëÖ—ï%ÕºÄÑÙÙÅïë•—•πùÖ—ï%Õº§ÅÏÄê†àçëÖ‰µïë•–µï……Ω»à§π—ï·—Ωπ—ïπ–ÄÙÄãBFB˚BÀB◊FF3FB‘ÉFB◊BÎFFÉB‡ÉFB˚FFB√B˜B„FB‘ÉBˇFB◊B€B˜F;F8ÉB”B√FF∏àÏÄê†àçëÖ‰µïë•–µï……Ω»à§π°•ëëï∏ÄÙÅôÖ±ÕîÏÅ…ï—’…∏ÏÅÙÅÖ›Ö•–ÅÖ¡§†àΩÖ¡§ΩëÖÂÃà∞ÅÏÅµï—°ΩêËÄâA=MPà∞Å°ïÖëï…ÃËÅÏÄâçΩπ—ïπ–µ—Â¡îàËÄâÖ¡¡±•çÖ—•Ω∏Ω©ÕΩ∏àÅÙ∞ÅâΩë‰ËÅ)M=8πÕ—…•πù•ô‰°ÏÅ—ï·–ÅÙ§ÅÙ§ÏÄê†àçëÖ‰µïë•–µë•Ö±Ωúà§πç±ΩÕî†§ÏÅÖ›Ö•–Å±ΩÖë1ïëùï»†§ÏÅÙ§Ï((êê†ùmëÖ—Ñµç±ΩÕîµë•Ö±Ωùtú§πôΩ…Öç††°â’——Ω∏§ÄÙ¯Åâ’——Ω∏πÖëëŸïπ—1•Õ—ïπï»†âç±•ç¨à∞Ä†§ÄÙ¯ÅëΩç’µïπ–πùï—±ïµïπ—	Â%ê°â’——Ω∏πëÖ—ÖÕï–πç±ΩÕï•Ö±Ωú§πç±ΩÕî†§§§Ï(ê†àç¡±Öçîµëï—Ö•∞µë•Ö±Ωúà§πÖëëŸïπ—1•Õ—ïπï»†âç±ΩÕîà∞Ä†§ÄÙ¯ÅÏ(ÄÅ•òÄ°±ΩçÖ—•Ω∏π¡Ö—°πÖµîπÕ—Ö…—Õ]•—††àΩµÖ¿ΩÖ¡Ö…—µïπ—Ãºà§§Å°•Õ—Ω…‰π…ï¡±ÖçïM—Ö—î°ÌÙ∞Äàà∞ÅÄΩµÖ¿˝Ÿ•ï‹ÙëÌµÖ¡5ΩëïıÄ§Ï)Ù§Ï(ê†àç¡ÖÂµïπ–µëÖ—îà§πŸÖ±’îÄÙÅπï‹ÅÖ—î†§π—Ω%M=M—…•πú†§πÕ±•çî†¿∞Äƒ¿§Ï()ÖÕÂπåÅô’πç—•Ω∏Å…ïµΩŸï1ïùÖçÂ=ôô±•πî†§ÅÏ(ÄÅ—…‰ÅÏÅ•òÄ†âÕï…Ÿ•çï]Ω…≠ï»àÅ•∏ÅπÖŸ•ùÖ—Ω»§ÅôΩ»Ä°çΩπÕ–Å…ïù•Õ—…Ö—•Ω∏ÅΩòÅÖ›Ö•–ÅπÖŸ•ùÖ—Ω»πÕï…Ÿ•çï]Ω…≠ï»πùï—Iïù•Õ—…Ö—•ΩπÃ†§§ÅÖ›Ö•–Å…ïù•Õ—…Ö—•Ω∏π’π…ïù•Õ—ï»†§ÏÅÙÅçÖ—ç†ÅÌÙ(ÄÅ—…‰ÅÏÅ•òÄ†âçÖç°ïÃàÅ•∏Åù±ΩâÖ±Q°•Ã§ÅôΩ»Ä°çΩπÕ–Å≠ï‰ÅΩòÅÖ›Ö•–ÅçÖç°ïÃπ≠ïÂÃ†§§Å•òÄ°≠ï‰πÕ—Ö…—Õ]•—††âµÖ•ëÖ•êµÕ°ï±∞¥à§§ÅÖ›Ö•–ÅçÖç°ïÃπëï±ï—î°≠ï‰§ÏÅÙÅçÖ—ç†ÅÌÙ)Ù()Ö›Ö•–Å…ïµΩŸï1ïùÖçÂ=ôô±•πî†§Ï)—…‰ÅÏÅ¡…Ωë’ç—Iï±ïÖÕîÄÙÅ9’µâï»†°Ö›Ö•–ÅÖ¡§†àΩÖ¡§ΩÖ¡¿µçΩπô•úà§§π¡…Ωë’ç—Iï±ïÖÕî§ÅÒÄƒÏÅÙÅçÖ—ç†ÅÏÅ¡…Ωë’ç—Iï±ïÖÕîÄÙÄƒÏÅÙ(ê†àçÖëêµ¡±Öçîµâ’——Ω∏à§π°•ëëï∏ÄÙÅ¡…Ωë’ç—Iï±ïÖÕîÄÄ»Ï(ê†àç¡±Öçîµô•±—ï»à§π°•ëëï∏ÄÙÅ¡…Ωë’ç—Iï±ïÖÕîÄÄ»Ï)Ö›Ö•–ÅÕ°Ω›IΩ’—î°…Ω’—ï…ΩµAÖ—††§§Ï)çΩπÕ–Åë•…ïç—¡Ö…—µïπ–ÄÙÅ±ΩçÖ—•Ω∏π¡Ö—°πÖµîπµÖ—ç††ΩypΩµÖ¡pΩÖ¡Ö…—µïπ—Õpº°qê¨§êº§Ï)•òÄ°ë•…ïç—¡Ö…—µïπ–§ÅÖ›Ö•–ÅΩ¡ïπ¡Ö…—µïπ—ï—Ö•∞°9’µâï»°ë•…ïç—¡Ö…—µïπ—l≈t§∞ÅôÖ±Õî§Ï(