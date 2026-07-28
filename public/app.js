const $ = (selector) => document.querySelector(selector);
const editor = $("#editor");
const preview = $("#preview");
const result = $("#result");
const textarea = $("#source-text");
const characterCount = $("#character-count");
const previewButton = $("#preview-button");
const editButton = $("#edit-button");
const confirmButton = $("#confirm-button");
const copyButton = $("#copy-button");
const shareButton = $("#share-button");
const requestError = $("#request-error");
const issueList = $("#issue-list");
const parsedSummary = $("#parsed-summary");
const shareText = $("#share-text");
const shareStatus = $("#share-status");
const ledgerTotals = $("#ledger-totals");
const ledgerRows = $("#ledger-rows");
const ledgerError = $("#ledger-error");
const paymentForm = $("#payment-form");
const paymentDate = $("#payment-date");
const paymentAmount = $("#payment-amount");
const paymentNote = $("#payment-note");

let latestPreview = null;

const formatTime = (minutes) => minutes == null ? "?" : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const formatHours = (minutes) => `${Number((minutes / 60).toFixed(2))} ч`;
const formatMoney = (cents) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;
const typeLabel = (type) => ({ independent: "Самостоятельная уборка", orientation: "Ознакомление", practice: "Практика", checkin: "Check in" })[type] ?? "Тип не указан";
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[character]);
const safeMapsUrl = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && ["google.com", "www.google.com", "maps.google.com", "maps.app.goo.gl"].includes(url.hostname) ? url.href : null;
  } catch { return null; }
};

textarea.addEventListener("input", () => { characterCount.textContent = `${textarea.value.length.toLocaleString("ru-RU")} / 32 768`; });

function setStatus(message, kind = "success") {
  shareStatus.textContent = message; shareStatus.className = `notice ${kind}`; shareStatus.hidden = false;
}

async function api(url, options) {
  const response = await fetch(url, options);
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "request_failed");
  return body;
}

function renderPreview(data) {
  const problems = [...data.issues.map((issue) => issue.message), ...data.unparsedLines.map((line) => `Не распознано: ${line}`)];
  issueList.hidden = problems.length === 0;
  issueList.innerHTML = problems.length ? `<strong>Нужно исправить</strong><ul>${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>` : "";
  const jobs = data.parsed.jobs.map((job) => {
    const expenses = data.parsed.expenses.filter((expense) => expense.object === job.object);
    const mapsUrl = safeMapsUrl(job.mapsUrl);
    const apartment = job.apartmentId == null ? "" : `<div class="apartment-details">${job.address ? `<span class="apartment-address">${escapeHtml(job.address)}</span>` : ""}${mapsUrl ? `<a class="maps-button" href="${escapeHtml(mapsUrl)}" target="_blank" rel="noopener noreferrer">Google Maps</a>` : ""}${job.noteBody ? `<details><summary>Инструкции</summary><pre>${escapeHtml(job.noteBody)}</pre></details>` : ""}</div>`;
    return `<article class="job"><strong>${escapeHtml(job.object)}</strong><span>${formatTime(job.startMinutes)}–${formatTime(job.endMinutes)}</span><small>${typeLabel(job.workType)}${job.companion ? ` · ${escapeHtml(job.companion)}` : ""}</small>${expenses.length ? `<small class="job-expenses">Расходы: ${expenses.map((expense) => `${escapeHtml(expense.category)} ${formatMoney(expense.amountCents)}`).join(", ")}</small>` : ""}${apartment}</article>`;
  }).join("");
  const unmatched = data.parsed.expenses.filter((expense) => !expense.object || !data.parsed.jobs.some((job) => job.object === expense.object));
  const expenses = unmatched.map((expense) => `<article class="expense"><strong>${escapeHtml(expense.category)}${expense.object ? ` · ${escapeHtml(expense.object)}` : ""}</strong><span>${formatMoney(expense.amountCents)}</span></article>`).join("");
  parsedSummary.innerHTML = `<div class="date-card">${escapeHtml(data.parsed.displayDate ?? "Дата не определена")}</div><div class="job-list">${jobs || "<p>Работы не найдены.</p>"}</div>${expenses ? `<div class="expense-list">${expenses}</div>` : ""}<div class="totals"><div class="total"><span>Время</span><strong>${formatHours(data.totals.minutes)}</strong></div><div class="total"><span>Заработок</span><strong>${formatMoney(data.totals.incomeCents)}</strong></div><div class="total"><span>Расходы</span><strong>${formatMoney(data.totals.expensesCents)}</strong></div></div>${data.advanceCents ? `<p class="notice success">Аванс в тексте: ${formatMoney(data.advanceCents)} · остаток после сохранения: ${formatMoney(data.projectedBalance)}</p>` : ""}`;
  confirmButton.disabled = !data.canShare; preview.hidden = false; result.hidden = true;
  preview.scrollIntoView({ behavior: "smooth", block: "start" });
}

previewButton.addEventListener("click", async () => {
  requestError.hidden = true; previewButton.disabled = true; previewButton.textContent = "Проверяю…";
  try { latestPreview = await api("/api/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: textarea.value }) }); renderPreview(latestPreview); }
  catch (error) { requestError.textContent = error.message === "invalid_request" ? "Введите сообщение длиной до 32 КБ." : "Не удалось проверить сообщение."; requestError.hidden = false; }
  finally { previewButton.disabled = false; previewButton.textContent = "Проверить"; }
});

editButton.addEventListener("click", () => { editor.scrollIntoView({ behavior: "smooth", block: "start" }); textarea.focus({ preventScroll: true }); });

confirmButton.addEventListener("click", async () => {
  if (!latestPreview?.canShare) return;
  confirmButton.disabled = true;
  try {
    const saved = await api("/api/days", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: textarea.value }) });
    latestPreview.shareText = saved.shareText;
    shareText.textContent = saved.shareText;
    result.hidden = false; shareStatus.hidden = true; result.scrollIntoView({ behavior: "smooth", block: "start" });
    await loadLedger();
  } catch { requestError.textContent = "Не удалось сохранить день."; requestError.hidden = false; }
  finally { confirmButton.disabled = false; }
});

async function copyResult() { await navigator.clipboard.writeText(latestPreview.shareText); setStatus("Текст скопирован."); }
copyButton.addEventListener("click", async () => { try { await copyResult(); } catch { setStatus("Не удалось скопировать текст. Выделите его вручную.", "error"); } });
shareButton.addEventListener("click", async () => {
  if (!latestPreview?.shareText) return;
  if (navigator.share) { try { await navigator.share({ text: latestPreview.shareText }); return; } catch (error) { if (error instanceof DOMException && error.name === "AbortError") return; } }
  try { await copyResult(); setStatus("Системная отправка недоступна — текст скопирован."); } catch { setStatus("Не удалось поделиться или скопировать текст.", "error"); }
});

function renderLedger(data) {
  const totals = data.totals;
  ledgerTotals.innerHTML = [["Заработано", totals.earnedCents], ["Получено", totals.receivedCents], ["Остаток", totals.outstandingCents], ["Расходы", totals.expensesCents]].map(([label, cents]) => `<div class="total"><span>${label}</span><strong>${formatMoney(cents)}</strong></div>`).join("");
  ledgerRows.innerHTML = data.rows.length ? data.rows.map((row) => {
    if (row.rowType === "work") return `<article class="ledger-row"><time>${escapeHtml(row.dateIso)}</time><div><strong>${formatHours(row.minutes)} работы</strong><br><small>${formatMoney(row.incomeCents)} заработано · ${formatMoney(row.expensesCents)} расходы</small></div><button class="secondary" data-delete-day="${escapeHtml(row.dateIso)}" type="button">Удалить день</button></article>`;
    const manual = row.source === "manual";
    return `<article class="ledger-row"><time>${escapeHtml(row.dateIso)}</time><div><strong>${formatMoney(row.amountCents)} получено</strong><br><small>${escapeHtml(row.note ?? (manual ? "Ручная оплата" : "Аванс из отчёта"))}</small></div>${manual ? `<div class="ledger-row-actions"><button class="secondary" data-edit-payment="${row.id}" data-date="${escapeHtml(row.dateIso)}" data-amount="${row.amountCents}" data-note="${escapeHtml(row.note ?? "")}" type="button">Изменить</button><button class="secondary" data-delete-payment="${row.id}" type="button">Удалить</button></div>` : "<span>Из текста</span>"}</article>`;
  }).join("") : "<p>Записей пока нет.</p>";
}

async function loadLedger() {
  try { ledgerError.hidden = true; renderLedger(await api("/api/ledger")); }
  catch { ledgerError.textContent = "Не удалось загрузить историю."; ledgerError.hidden = false; }
}

paymentForm.addEventListener("submit", async (event) => {
  event.preventDefault(); ledgerError.hidden = true;
  try {
    await api("/api/payments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dateIso: paymentDate.value, amountCents: Math.round(Number(paymentAmount.value) * 100), note: paymentNote.value || undefined }) });
    paymentAmount.value = ""; paymentNote.value = ""; await loadLedger();
  } catch { ledgerError.textContent = "Не удалось добавить оплату."; ledgerError.hidden = false; }
});

ledgerRows.addEventListener("click", async (event) => {
  const edit = event.target.closest("[data-edit-payment]");
  const remove = event.target.closest("[data-delete-payment]");
  const removeDay = event.target.closest("[data-delete-day]");
  if (edit) {
    const dateIso = prompt("Дата оплаты (ГГГГ-ММ-ДД):", edit.dataset.date);
    if (dateIso === null) return;
    const amount = prompt("Сумма в евро:", String(Number(edit.dataset.amount) / 100));
    if (amount === null) return;
    const note = prompt("Примечание:", edit.dataset.note);
    if (note === null) return;
    const cents = Math.round(Number(amount.replace(",", ".")) * 100);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso) || !Number.isInteger(cents) || cents <= 0) { ledgerError.textContent = "Проверьте дату и положительную сумму."; ledgerError.hidden = false; return; }
    try { await api(`/api/payments/${edit.dataset.editPayment}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ dateIso, amountCents: cents, note }) }); await loadLedger(); }
    catch { ledgerError.textContent = "Не удалось изменить оплату."; ledgerError.hidden = false; }
  }
  if (remove && confirm("Удалить эту оплату?")) {
    try { await api(`/api/payments/${remove.dataset.deletePayment}`, { method: "DELETE" }); await loadLedger(); }
    catch { ledgerError.textContent = "Не удалось у…14170 tokens truncated…text',$1)",
        [input.dateIso, input.advanceCents],
      );
      const previous = await this.aggregate(client, "date_iso < $1", [input.dateIso]);
      const total = await this.aggregate(client, "date_iso <= $1", [input.dateIso]);
      await client.query("COMMIT");
      return { day: mapDay(saved.rows[0]), snapshot: { previous, total } };
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async deleteDay(dateIso: string): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM work_days WHERE date_iso=$1", [dateIso]);
    return (result.rowCount ?? 0) > 0;
  }

  async getLedger(from?: string, to?: string): Promise<LedgerView> {
    const values: string[] = []; const clauses: string[] = [];
    if (from) { values.push(from); clauses.push(`date_iso >= $${values.length}`); }
    if (to) { values.push(to); clauses.push(`date_iso <= $${values.length}`); }
    const condition = clauses.length ? clauses.join(" AND ") : "TRUE";
    const [totals, days, payments] = await Promise.all([
      this.aggregate(this.pool, condition, values),
      this.pool.query(`SELECT * FROM work_days WHERE ${condition} ORDER BY date_iso, updated_at`, values),
      this.pool.query(`SELECT * FROM payments WHERE ${condition.replaceAll("date_iso", "payment_date")} ORDER BY payment_date, id`, values),
    ]);
    const rows: LedgerRow[] = [
      ...days.rows.map((row) => ({ rowType: "work" as const, ...mapDay(row) })),
      ...payments.rows.map((row) => ({ rowType: "payment" as const, ...mapPayment(row) })),
    ].sort((a, b) => a.dateIso.localeCompare(b.dateIso) || (a.rowType === "work" ? -1 : 1));
    return { totals, rows };
  }

  async createPayment(dateIso: string, amountCents: number, note?: string): Promise<Payment> {
    const result = await this.pool.query(
      "INSERT INTO payments (payment_date,amount_cents,note,source) VALUES ($1,$2,$3,'manual') RETURNING *",
      [dateIso, amountCents, note?.trim() || null],
    );
    return mapPayment(result.rows[0]);
  }

  async updatePayment(id: number, values: { dateIso?: string; amountCents?: number; note?: string | null }): Promise<Payment | null> {
    const result = await this.pool.query(`
      UPDATE payments SET payment_date=COALESCE($2,payment_date), amount_cents=COALESCE($3,amount_cents),
        note=CASE WHEN $4::boolean THEN $5 ELSE note END, updated_at=now()
      WHERE id=$1 AND source='manual' RETURNING *
    `, [id, values.dateIso ?? null, values.amountCents ?? null, values.note !== undefined, values.note?.trim() || null]);
    return result.rows[0] ? mapPayment(result.rows[0]) : null;
  }

  async deletePayment(id: number): Promise<boolean> {
    const result = await this.pool.query("DELETE FROM payments WHERE id=$1 AND source='manual'", [id]);
    return (result.rowCount ?? 0) > 0;
  }

  async getActiveApartments(): Promise<Apartment[]> {
    const result = await this.pool.query("SELECT * FROM apartments WHERE active=true ORDER BY canonical_name");
    return result.rows.map(mapApartment);
  }

  async importApartments(records: ApartmentImportInput[], dryRun: boolean): Promise<ApartmentImportResult> {
    const client = await this.pool.connect();
    const result: ApartmentImportResult = { created: 0, updated: 0, skipped: 0, conflicts: [] };
    try {
      await client.query("BEGIN");
      const existingResult = await client.query("SELECT * FROM apartments FOR UPDATE");
      const existing = existingResult.rows.map(mapApartment);
      for (const record of records) {
        const canonicalKey = apartmentKey(record.canonicalName);
        const bySource = existing.find((item) => item.sourceKey === record.sourceKey);
        const byCanonical = existing.find((item) => item.canonicalKey === canonicalKey);
        if (bySource && byCanonical && bySource.id !== byCanonical.id) {
          result.conflicts.push({ sourceKey: record.sourceKey, reason: "source_key_and_canonical_key_disagree" }); continue;
        }
        const current = bySource ?? byCanonical;
        const aliases = [...new Set([record.canonicalName, ...record.aliases].map((value) => value.trim()))];
        const aliasKeys = new Set(aliases.map(apartmentKey));
        const aliasOwner = existing.find((item) => item.id !== current?.id && [item.canonicalName, ...item.aliases].some((alias) => aliasKeys.has(apartmentKey(alias))));
        if (aliasOwner) { result.conflicts.push({ sourceKey: record.sourceKey, reason: "alias_belongs_to_another_apartment" }); continue; }
        const comparable = { sourceKey: record.sourceKey, canonicalKey, canonicalName: record.canonicalName, aliases, address: record.address, mapsUrl: record.mapsUrl, noteBody: record.noteBody, active: record.active };
        if (current && JSON.stringify({ sourceKey: current.sourceKey, canonicalKey: current.canonicalKey, canonicalName: current.canonicalName, aliases: current.aliases, address: current.address, mapsUrl: current.mapsUrl, noteBody: current.noteBody, active: current.active }) === JSON.stringify(comparable)) {
          result.skipped += 1; continue;
        }
        const saved = current
          ? await client.query(`UPDATE apartments SET source_key=$2, canonical_key=$3, canonical_name=$4, aliases=$5::jsonb, address=$6, maps_url=$7, note_body=$8, active=$9, updated_at=now() WHERE id=$1 RETURNING *`, [current.id, record.sourceKey, canonicalKey, record.canonicalName, JSON.stringify(aliases), record.address, record.mapsUrl, record.noteBody, record.active])
          : await client.query(`INSERT INTO apartments (source_key, canonical_key, canonical_name, aliases, address, maps_url, note_body, active) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8) RETURNING *`, [record.sourceKey, canonicalKey, record.canonicalName, JSON.stringify(aliases), record.address, record.mapsUrl, record.noteBody, record.active]);
        const mapped = mapApartment(saved.rows[0]);
        if (current) { existing.splice(existing.indexOf(current), 1, mapped); result.updated += 1; }
        else { existing.push(mapped); result.created += 1; }
      }
      if (dryRun) await client.query("ROLLBACK"); else await client.query("COMMIT");
      return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
}
