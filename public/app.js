const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
const formatTime = (minutes) => minutes == null ? "?" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const formatHours = (minutes) => `${Number((minutes / 60).toFixed(2))} ч`;
const formatMoney = (cents) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;
const typeLabel = (type) => ({ independent: "Самостоятельная уборка", orientation: "Ознакомление", practice: "Практика", checkin: "Check in" })[type] ?? "Тип не указан";
const kindLabel = (kind) => ({ apartment: "Квартира", laundry: "Сушка", partner_restaurant: "Партнёр" })[kind] ?? "Место";
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
  const problems = [...data.issues.map((issue) => issue.message), ...data.unparsedLines.map((line) => `Не распознано: ${line}`)];
  $("#issue-list").hidden = !problems.length;
  $("#issue-list").innerHTML = problems.length ? `<strong>Нужно исправить</strong><ul>${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>` : "";
  const jobs = data.parsed.jobs.map((job, jobIndex) => {
    const expenses = data.parsed.expenses.filter((expense) => expense.jobIndex === jobIndex || (expense.jobIndex == null && expense.object === job.object));
    const timing = job.startMinutes != null && job.endMinutes != null ? `${formatTime(job.startMinutes)}–${formatTime(job.endMinutes)}` : formatHours(job.durationMinutes);
    const apartmentAction = job.apartmentId
      ? `<button class="ghost" data-preview-apartment="${job.apartmentId}" type="button">Открыть квартиру</button>`
      : productRelease >= 2 ? `<button class="ghost" data-add-unknown-apartment="${escapeHtml(job.object)}" type="button">+ Добавить квартиру</button>` : "";
    return `<article class="job"><strong>${escapeHtml(job.object)}</strong><span>${timing}</span><small>${typeLabel(job.workType)}${job.companion ? ` · ${escapeHtml(job.companion)}` : ""}</small>${expenses.length ? `<small class="job-expenses">Расходы: ${expenses.map((expense) => `${escapeHtml(expense.category)} ${formatMoney(expense.amountCents)}`).join(", ")}</small>` : ""}<small>${apartmentAction}</small></article>`;
  }).join("");
  const unmatched = data.parsed.expenses.filter((expense) => expense.jobIndex == null && (!expense.object || !data.parsed.jobs.some((job) => job.object === expense.object)));
  const expenses = unmatched.map((expense) => `<article class="expense"><strong>${escapeHtml(expense.category)}${expense.object ? ` · ${escapeHtml(expense.object)}` : ""}</strong><span>${formatMoney(expense.amountCents)}</span></article>`).join("");
  $("#parsed-summary").innerHTML = `<p class="muted">${escapeHtml(data.parsed.displayDate ?? "Дата не определена")}</p><div class="job-list">${jobs || "<p>Работы не найдены.</p>"}</div>${expenses ? `<div class="expense-list">${expenses}</div>` : ""}<div class="totals"><div class="total"><span>Время</span><strong>${formatHours(data.totals.minutes)}</strong></div><div class="total"><span>Заработок</span><strong>${formatMoney(data.totals.incomeCents)}</strong></div><div class="total"><span>Расходы</span><strong>${formatMoney(data.totals.expensesCents)}</strong></div></div>`;
  $("#confirm-button").disabled = !data.canShare;
  setTodayState("preview");
}

$("#preview-button").addEventListener("click", async () => {
  const button = $("#preview-button"); $("#request-error").hidden = true; button.disabled = true; button.textContent = "Проверяю…";
  try { latestPreview = await api("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: textarea.value }) }); renderPreview(latestPreview); }
  catch { $("#request-error").textContent = "Не удалось проверить сообщение."; $("#request-error").hidden = false; }
  finally { button.disabled = false; button.textContent = "Проверить"; }
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
  } catch { $("#request-error").textContent = "Не удалось сохранить день."; $("#request-error").hidden = false; setTodayState("editor"); }
  finally { button.disabled = false; }
});
$("#parsed-summary").addEventListener("click", async (event) => {
  const apartmentButton = event.target.closest("[data-preview-apartment]");
  const addButton = event.target.closest("[data-add-unknown-apartment]");
  if (apartmentButton) { await showRoute("map", true); await openApartmentDetail(Number(apartmentButton.dataset.previewApartment)); }
  if (addButton) openPlaceForm("apartment", addButton.dataset.addUnknownApartment);
});
async function copyResult() { await navigator.clipboard.writeText(latestPreview.shareText); $("#share-status").textContent = "Текст скопирован."; $("#share-status").hidden = false; }
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
  } catch { $("#map-error").textContent = "Не удалось загрузить места."; $("#map-error").hidden = false; }
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
      ? `<button class="secondary" data-locate-apartment="${item.id}" type="button">Указать место</button>`
      : `<button class="secondary" data-open-item="${item.itemType}:${item.id}" type="button">Открыть</button>`;
    return `<article class="place-card"><div><span class="place-kind">${kindLabel(item.kind)}</span><strong>${escapeHtml(item.name)}</strong><p class="${item.latitude == null ? "missing-location" : ""}">${escapeHtml(item.address || (item.latitude == null ? "Нужно указать местоположение" : "Координаты сохранены"))}</p></div>${action}</article>`;
  }).join("") : "<p class=\"muted\">Ничего не найдено.</p>";
}
$("#place-search").addEventListener("input", renderPlaceList); $("#place-filter").addEventListener("change", renderPlaceList);
$("#place-list").addEventListener("click", (event) => {
  const locate = event.target.closest("[data-locate-apartment]");
  if (locate) { openEditForm(`apartment:${locate.dataset.locateApartment}`); return; }
  const button = event.target.closest("[data-open-item]"); if (button) openItemDetail(button.dataset.openItem);
});

function renderPlacesMap() {
  const host = $("#places-map");
  if (!globalThis.L) { $("#map-empty").textContent = "Карта не загрузилась. Список мест по-прежнему доступен."; $("#map-empty").hidden = false; return; }
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
  $("#map-empty").hidden = located.length > 0; $("#map-empty").textContent = located.length ? "" : "Пока ни у одной квартиры нет координат. Откройте список и укажите местоположение.";
}

async function openItemDetail(key, push = true) {
  const [type, idText] = key.split(":"); const id = Number(idText);
  if (type === "apartment") return openApartmentDetail(id, push);
  const item = savedPlaces.find((place) => place.id === id); if (!item) return;
  const mapLink = mapsHref(item);
  $("#place-detail").innerHTML = `<span class="place-kind">${kindLabel(item.kind)}</span><h2>${escapeHtml(item.name)}</h2><p class="detail-address">${escapeHtml(item.address || "Адрес не указан")}</p>${item.note ? `<p class="detail-note">${escapeHtml(item.note)}</p>` : ""}<div class="detail-actions">${mapLink ? `<a class="primary action-link" href="${escapeHtml(mapLink)}" target="_blank" rel="noopener noreferrer">Маршрут</a>` : ""}<button class="secondary" data-edit-item="place:${item.id}" type="button">Изменить</button><button class="ghost" data-archive-place="${item.id}" type="button">Архивировать</button></div>`;
  $("#place-detail-dialog").showModal();
}

async function openApartmentDetail(id, push = true) {
  try {
    const { apartment, preferredLaundry } = await api(`/api/apartments/${id}`);
    const mapLink = mapsHref(apartment);
    const editLabel = apartment.latitude == null ? "Указать место" : "Изменить";
    const releaseActions = `${productRelease >= 3 ? `<button class="secondary" data-find-laundry="${apartment.id}" type="button">Сушки рядом</button>` : ""}<button class="ghost" data-edit-item="apartment:${apartment.id}" type="button">${editLabel}</button>`;
    $("#place-detail").innerHTML = `<span class="place-kind">Квартира</span><h2>${escapeHtml(apartment.canonicalName)}</h2><p class="detail-address ${apartment.latitude == null ? "missing-location" : ""}">${escapeHtml(apartment.address || (apartment.latitude == null ? "Нужно указать местоположение" : "Координаты сохранены"))}</p>${apartment.noteBody ? `<pre class="detail-note">${escapeHtml(apartment.noteBody)}</pre>` : ""}${preferredLaundry ? `<div class="notice success"><strong>Выбранная сушка</strong><br>${escapeHtml(preferredLaundry.name)}</div>` : ""}<div class="detail-actions">${mapLink ? `<a class="primary action-link" href="${escapeHtml(mapLink)}" target="_blank" rel="noopener noreferrer">Маршрут</a>` : ""}${releaseActions}</div>`;
    $("#place-detail-dialog").showModal();
    if (push && location.pathname !== `/map/apartments/${id}`) history.pushState({}, "", `/map/apartments/${id}?view=${mapMode}`);
  } catch { $("#map-error").textContent = "Не удалось открыть квартиру."; $("#map-error").hidden = false; }
}

$("#place-detail").addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-item]"); const archive = event.target.closest("[data-archive-place]"); const laundry = event.target.closest("[data-find-laundry]");
  if (edit) { $("#place-detail-dialog").close(); openEditForm(edit.dataset.editItem); }
  if (archive && confirm("Убрать это место в архив?")) { await api(`/api/places/${archive.dataset.archivePlace}`, { method: "DELETE" }); $("#place-detail-dialog").close(); mapItems = []; await loadMapItems(true); }
  if (laundry) { $("#place-detail-dialog").close(); await findNearbyLaundry(Number(laundry.dataset.findLaundry)); }
});

function resetPlaceForm() {
  $("#place-form").reset(); $("#place-edit-id").value = ""; $("#place-latitude").value = ""; $("#place-longitude").value = ""; $("#place-location-source").value = ""; $("#place-location-accuracy").value = "";
  $("#place-kind").disabled = false;
  $("#coordinate-picker").hidden = true; $("#place-form-error").hidden = true; $("#place-location-status").textContent = "Сначала попробуем определить точку по адресу.";
}
function fillApartmentSelect() { $("#place-apartment-link").innerHTML = `<option value="">Не связывать</option>${apartments.map((item) => `<option value="${item.id}">${escapeHtml(item.canonicalName)}</option>`).join("")}`; }
function updatePlaceKind() { $("#place-apartment-link-label").hidden = $("#place-kind").value !== "laundry"; }
$("#place-kind").addEventListener("change", updatePlaceKind);
function openPlaceForm(kind = "apartment", name = "") { resetPlaceForm(); $("#place-form-title").textContent = "Добавить место"; $("#place-kind").value = kind; $("#place-name").value = name; fillApartmentSelect(); updatePlaceKind(); $("#place-form-dialog").showModal(); }
$("#add-place-button").addEventListener("click", () => openPlaceForm());
function openEditForm(key) {
  const [type, idText] = key.split(":"); const id = Number(idText); const item = type === "apartment" ? apartments.find((entry) => entry.id === id) : savedPlaces.find((entry) => entry.id === id); if (!item) return;
  resetPlaceForm(); $("#place-form-title").textContent = "Изменить место"; $("#place-edit-id").value = key; $("#place-kind").value = item.kind ?? "apartment"; $("#place-name").value = item.canonicalName ?? item.name; $("#place-address").value = item.address ?? ""; $("#place-maps-url").value = item.mapsUrl ?? ""; $("#place-note").value = item.noteBody ?? item.note ?? ""; $("#place-latitude").value = item.latitude ?? ""; $("#place-longitude").value = item.longitude ?? ""; $("#place-location-source").value = item.locationSource ?? ""; updatePlaceKind(); $("#place-form-dialog").showModal();
  $("#place-kind").disabled = true;
}

$("#pick-location-button").addEventListener("click", () => {
  $("#coordinate-picker").hidden = false;
  if (!globalThis.L) { $("#place-location-status").textContent = "Карта выбора точки не загрузилась."; return; }
  setTimeout(() => {
    if (!pickerMap) { pickerMap = L.map("picker-map").setView([48.8566, 2.3522], 12); L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { attribution: "&copy; OpenStreetMap" }).addTo(pickerMap); pickerMap.on("click", ({ latlng }) => { $("#place-latitude").value = latlng.lat; $("#place-longitude").value = latlng.lng; $("#place-location-source").value = "pin"; $("#place-location-status").textContent = "Точка выбрана вручную."; }); }
    pickerMap.invalidateSize(); const lat = Number($("#place-latitude").value); const lon = Number($("#place-longitude").value); if (Number.isFinite(lat) && Number.isFinite(lon)) pickerMap.setView([lat, lon], 16);
  }, 0);
});
$("#current-location-button").addEventListener("click", () => {
  if (!navigator.geolocation) { $("#place-location-status").textContent = "Геолокация недоступна."; return; }
  $("#place-location-status").textContent = "Определяю текущее место…";
  navigator.geolocation.getCurrentPosition(({ coords }) => { $("#place-latitude").value = coords.latitude; $("#place-longitude").value = coords.longitude; $("#place-location-source").value = "geolocation"; $("#place-location-accuracy").value = coords.accuracy; $("#place-location-status").textContent = `Текущее место сохранено, точность около ${Math.round(coords.accuracy)} м.`; }, () => { $("#place-location-status").textContent = "Не удалось получить геолокацию. Место можно сохранить без точки."; }, { enableHighAccuracy: true, timeout: 10_000, maximumAge: 0 });
});

$("#place-form").addEventListener("submit", async (event) => {
  event.preventDefault(); const error = $("#place-form-error"); error.hidden = true;
  const kind = $("#place-kind").value; const editKey = $("#place-edit-id").value; const latitude = $("#place-latitude").value === "" ? undefined : Number($("#place-latitude").value); const longitude = $("#place-longitude").value === "" ? undefined : Number($("#place-longitude").value);
  const common = { address: $("#place-address").value || null, mapsUrl: $("#place-maps-url").value || null, latitude, longitude, locationSource: $("#place-location-source").value || undefined, locationAccuracyMeters: $("#place-location-accuracy").value === "" ? undefined : Number($("#place-location-accuracy").value) };
  try {
    if (kind === "apartment") {
      const payload = { canonicalName: $("#place-name").value, noteBody: $("#place-note").value || null, ...common }; if (!editKey) payload.aliases = [];
      const endpoint = editKey ? `/api/apartments/${editKey.split(":")[1]}` : "/api/apartments"; await api(endpoint, { method: editKey ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    } else {
      const payload = { kind, name: $("#place-name").value, note: $("#place-note").value || null, apartmentId: $("#place-apartment-link").value ? Number($("#place-apartment-link").value) : undefined, ...common };
      const endpoint = editKey ? `/api/places/${editKey.split(":")[1]}` : "/api/places"; if (editKey) delete payload.apartmentId; await api(endpoint, { method: editKey ? "PATCH" : "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    }
    $("#place-form-dialog").close(); mapItems = []; await loadMapItems(true);
  } catch (caught) { error.textContent = caught.message === "apartment_exists" ? "Квартира с таким названием уже существует." : "Не удалось сохранить место."; error.hidden = false; }
});

async function findNearbyLaundry(apartmentId) {
  const results = $("#laundry-results"); results.innerHTML = "<p class=\"muted\">Ищу ближайшие варианты…</p>"; $("#laundry-dialog").showModal();
  try {
    const data = await api(`/api/apartments/${apartmentId}/nearby-laundries`);
    results.innerHTML = `${data.preferredLaundry ? `<div class="notice success"><strong>Сейчас выбрана:</strong> ${escapeHtml(data.preferredLaundry.name)}</div>` : ""}<div class="laundry-list">${data.candidates.length ? data.candidates.map((item, index) => `<article class="laundry-card"><strong>${escapeHtml(item.name)}</strong><p class="muted">${Math.round(item.distanceMeters)} м · ${item.dryerConfirmed ? "сушилка отмечена в OSM" : "наличие сушилки стоит проверить"}</p><div class="detail-actions"><a class="secondary action-link" href="${escapeHtml(item.mapsUrl)}" target="_blank" rel="noopener noreferrer">Открыть карты</a><button class="primary" data-select-laundry="${index}" type="button">Выбрать</button></div></article>`).join("") : "<p>Рядом ничего не найдено.</p>"}</div>`;
    results.dataset.apartmentId = apartmentId; results._candidates = data.candidates;
  } catch (error) { results.innerHTML = `<p class="notice error">${error.message === "apartment_location_required" ? "Сначала укажите адрес или координаты квартиры." : "Поиск сушек временно недоступен."}</p>`; }
}
$("#laundry-results").addEventListener("click", async (event) => {
  const button = event.target.closest("[data-select-laundry]"); if (!button) return;
  const candidate = $("#laundry-results")._candidates?.[Number(button.dataset.selectLaundry)]; const apartmentId = Number($("#laundry-results").dataset.apartmentId); if (!candidate) return;
  await api(`/api/apartments/${apartmentId}/laundry-links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidate: { osmType: candidate.osmType, osmId: candidate.osmId, name: candidate.name, address: candidate.address, latitude: candidate.latitude, longitude: candidate.longitude } }) });
  $("#laundry-dialog").close(); mapItems = []; await loadMapItems(true); await openApartmentDetail(apartmentId, false);
});

const formatPeriod = (period) => { const [year, month] = period.split("-").map(Number); const label = new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric" }).format(new Date(year, month - 1, 1)); return label[0].toUpperCase() + label.slice(1); };
function renderLedger(data) {
  const totals = data.totals; ledgerDays = new Map(data.rows.filter((row) => row.rowType === "work").map((row) => [row.dateIso, row]));
  $("#ledger-totals").innerHTML = [["Часы", formatHours(totals.minutes)], ["Получено", formatMoney(totals.receivedCents)], ["Остаток", formatMoney(totals.outstandingCents)], ["Расходы", formatMoney(totals.expensesCents)]].map(([label, value]) => `<div class="summary-item"><span>${label}</span><strong>${value}</strong></div>`).join("");
  $("#ledger-rows").innerHTML = data.rows.length ? data.rows.map((row) => {
    if (row.rowType === "work") {
      const details = (row.parsedDetails?.jobs ?? []).map((job) => `<div class="ledger-detail-item"><strong>${escapeHtml(job.object)}</strong><small>${typeLabel(job.workType)}</small></div>`).join("");
      return `<article class="ledger-row"><time>${escapeHtml(row.dateIso)}</time><div><strong>${formatHours(row.minutes)} работы</strong><br><small>${formatMoney(row.incomeCents)} заработано · ${formatMoney(row.expensesCents)} расходы</small></div><div class="ledger-row-actions"><button class="secondary" data-edit-day="${row.dateIso}">Изменить</button><button class="ghost" data-delete-day="${row.dateIso}">Удалить</button></div><div class="ledger-day-tabs"><details class="ledger-day-details"><summary>Расписание</summary><pre>${escapeHtml(row.sourceText)}</pre></details><details class="ledger-day-details"><summary>Отчёт</summary><pre>${escapeHtml(row.reportText || "Отчёт не сохранён")}</pre></details><details class="ledger-day-details"><summary>Подробнее</summary><div class="ledger-detail-list">${details || "Работы не найдены"}</div></details></div></article>`;
    }
    const manual = row.source === "manual"; return `<article class="ledger-row"><time>${row.dateIso}</time><div><strong>${formatMoney(row.amountCents)} получено</strong><br><small>${escapeHtml(row.note || (manual ? "Ручная оплата" : "Аванс из отчёта"))}</small></div>${manual ? `<div class="ledger-row-actions"><button class="secondary" data-edit-payment="${row.id}" data-date="${row.dateIso}" data-amount="${row.amountCents}" data-note="${escapeHtml(row.note || "")}">Изменить</button><button class="ghost" data-delete-payment="${row.id}">Удалить</button></div>` : "<span class=\"muted\">Из текста</span>"}</article>`;
  }).join("") : "<p class=\"muted\">Записей пока нет.</p>";
}
async function loadLedger() { try { $("#ledger-error").hidden = true; $("#ledger-period-label").textContent = formatPeriod(selectedPeriod); renderLedger(await api(`/api/ledger?from=${selectedPeriod}-01&to=${selectedPeriod}-31`)); } catch { $("#ledger-error").textContent = "Не удалось загрузить историю."; $("#ledger-error").hidden = false; } }
$("#add-payment-button").addEventListener("click", () => $("#payment-dialog").showModal());
$("#payment-form").addEventListener("submit", async (event) => { event.preventDefault(); await api("/api/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dateIso: $("#payment-date").value, amountCents: Math.round(Number($("#payment-amount").value) * 100), note: $("#payment-note").value || undefined }) }); $("#payment-dialog").close(); $("#payment-amount").value = ""; $("#payment-note").value = ""; await loadLedger(); });
$("#periods-button").addEventListener("click", async () => { const { periods } = await api("/api/periods"); const available = [...new Set([calendarPeriod, ...periods.map(({ period }) => period)])]; $("#periods-list").innerHTML = available.map((period) => `<button class="${period === selectedPeriod ? "primary" : "secondary"}" data-period="${period}">${formatPeriod(period)}</button>`).join(""); $("#periods-dialog").showModal(); });
$("#periods-list").addEventListener("click", async (event) => { const button = event.target.closest("[data-period]"); if (!button) return; selectedPeriod = button.dataset.period; $("#periods-dialog").close(); await loadLedger(); });
$("#ledger-rows").addEventListener("click", async (event) => {
  const editDay = event.target.closest("[data-edit-day]"); const deleteDay = event.target.closest("[data-delete-day]"); const editPayment = event.target.closest("[data-edit-payment]"); const deletePayment = event.target.closest("[data-delete-payment]");
  if (editDay) { const day = ledgerDays.get(editDay.dataset.editDay); if (day) { editingDateIso = day.dateIso; $("#day-edit-date").textContent = day.dateIso; $("#day-edit-text").value = day.sourceText; $("#day-edit-dialog").showModal(); } }
  if (deleteDay && confirm(`Удалить рабочий день ${deleteDay.dataset.deleteDay}?`)) { await api(`/api/days/${deleteDay.dataset.deleteDay}`, { method: "DELETE" }); await loadLedger(); }
  if (deletePayment && confirm("Удалить эту оплату?")) { await api(`/api/payments/${deletePayment.dataset.deletePayment}`, { method: "DELETE" }); await loadLedger(); }
  if (editPayment) { const dateIso = prompt("Дата оплаты:", editPayment.dataset.date); if (dateIso == null) return; const amount = prompt("Сумма в евро:", String(Number(editPayment.dataset.amount) / 100)); if (amount == null) return; const note = prompt("Примечание:", editPayment.dataset.note); if (note == null) return; await api(`/api/payments/${editPayment.dataset.editPayment}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dateIso, amountCents: Math.round(Number(amount.replace(",", ".")) * 100), note }) }); await loadLedger(); }
});
$("#day-edit-form").addEventListener("submit", async (event) => { event.preventDefault(); const text = $("#day-edit-text").value; const preview = await api("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }); if (!preview.canShare || preview.parsed.dateIso !== editingDateIso) { $("#day-edit-error").textContent = "Проверьте текст и сохраните прежнюю дату."; $("#day-edit-error").hidden = false; return; } await api("/api/days", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) }); $("#day-edit-dialog").close(); await loadLedger(); });

$$('[data-close-dialog]').forEach((button) => button.addEventListener("click", () => document.getElementById(button.dataset.closeDialog).close()));
$("#place-detail-dialog").addEventListener("close", () => {
  if (location.pathname.startsWith("/map/apartments/")) history.replaceState({}, "", `/map?view=${mapMode}`);
});
$("#payment-date").value = new Date().toISOString().slice(0, 10);

async function removeLegacyOffline() {
  try { if ("serviceWorker" in navigator) for (const registration of await navigator.serviceWorker.getRegistrations()) await registration.unregister(); } catch {}
  try { if ("caches" in globalThis) for (const key of await caches.keys()) if (key.startsWith("maidaid-shell-")) await caches.delete(key); } catch {}
}

async function initializeApp() {
  await removeLegacyOffline();
  try { productRelease = Number((await api("/api/app-config")).productRelease) || 1; } catch { productRelease = 1; }
  $("#add-place-button").hidden = productRelease < 2;
  $("#place-filter").hidden = productRelease < 2;
  await showRoute(routeFromPath());
  const directApartment = location.pathname.match(/^\/map\/apartments\/(\d+)$/);
  if (directApartment) await openApartmentDetail(Number(directApartment[1]), false);
}

void initializeApp();
