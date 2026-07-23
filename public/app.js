const editor = document.querySelector("#editor");
const preview = document.querySelector("#preview");
const result = document.querySelector("#result");
const textarea = document.querySelector("#source-text");
const characterCount = document.querySelector("#character-count");
const previewButton = document.querySelector("#preview-button");
const editButton = document.querySelector("#edit-button");
const confirmButton = document.querySelector("#confirm-button");
const copyButton = document.querySelector("#copy-button");
const shareButton = document.querySelector("#share-button");
const requestError = document.querySelector("#request-error");
const issueList = document.querySelector("#issue-list");
const parsedSummary = document.querySelector("#parsed-summary");
const shareText = document.querySelector("#share-text");
const shareStatus = document.querySelector("#share-status");

let latestPreview = null;

const formatTime = (minutes) =>
  minutes == null
    ? "?"
    : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
const formatHours = (minutes) => `${Number((minutes / 60).toFixed(2))} ч`;
const formatMoney = (cents) => `${(cents / 100).toFixed(2).replace(".", ",")} €`;
const typeLabel = (type) =>
  type === "independent"
    ? "Самостоятельная уборка"
    : type === "orientation"
      ? "Ознакомление"
      : type === "practice"
        ? "Практика"
        : "Тип не указан";
const escapeHtml = (value) =>
  String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]);

textarea.addEventListener("input", () => {
  characterCount.textContent = `${textarea.value.length.toLocaleString("ru-RU")} / 32 768`;
});

function setStatus(message, kind = "success") {
  shareStatus.textContent = message;
  shareStatus.className = `notice ${kind}`;
  shareStatus.hidden = false;
}

function renderPreview(data) {
  const problems = [
    ...data.issues.map((issue) => issue.message),
    ...data.unparsedLines.map((line) => `Не распознано: ${line}`),
  ];
  issueList.hidden = problems.length === 0;
  issueList.innerHTML = problems.length
    ? `<strong>Нужно исправить</strong><ul>${problems.map((problem) => `<li>${escapeHtml(problem)}</li>`).join("")}</ul>`
    : "";

  const jobs = data.parsed.jobs.map((job) => `
    <article class="job">
      <strong>${escapeHtml(job.object)}</strong>
      <span>${formatTime(job.startMinutes)}–${formatTime(job.endMinutes)}</span>
      <small>${typeLabel(job.workType)}${job.companion ? ` · ${escapeHtml(job.companion)}` : ""}</small>
    </article>`).join("");
  const expenses = data.parsed.expenses.map((expense) => `
    <article class="expense">
      <strong>${escapeHtml(expense.category)}${expense.object ? ` · ${escapeHtml(expense.object)}` : ""}</strong>
      <span>${formatMoney(expense.amountCents)}</span>
    </article>`).join("");

  parsedSummary.innerHTML = `
    <div class="date-card">${escapeHtml(data.parsed.displayDate ?? "Дата не определена")}</div>
    <div class="job-list">${jobs || "<p>Работы не найдены.</p>"}</div>
    ${expenses ? `<div class="expense-list">${expenses}</div>` : ""}
    <div class="totals">
      <div class="total"><span>Время</span><strong>${formatHours(data.totals.minutes)}</strong></div>
      <div class="total"><span>Заработок</span><strong>${formatMoney(data.totals.incomeCents)}</strong></div>
      <div class="total"><span>Расходы</span><strong>${formatMoney(data.totals.expensesCents)}</strong></div>
    </div>`;
  confirmButton.disabled = !data.canShare;
  preview.hidden = false;
  result.hidden = true;
  preview.scrollIntoView({ behavior: "smooth", block: "start" });
}

previewButton.addEventListener("click", async () => {
  requestError.hidden = true;
  previewButton.disabled = true;
  previewButton.textContent = "Проверяю…";
  try {
    const response = await fetch("/api/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: textarea.value }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error === "invalid_request" ? "Введите сообщение длиной до 32 КБ." : "Не удалось проверить сообщение.");
    latestPreview = data;
    renderPreview(data);
  } catch (error) {
    requestError.textContent = error instanceof Error ? error.message : "Не удалось проверить сообщение.";
    requestError.hidden = false;
  } finally {
    previewButton.disabled = false;
    previewButton.textContent = "Проверить";
  }
});

editButton.addEventListener("click", () => {
  editor.scrollIntoView({ behavior: "smooth", block: "start" });
  textarea.focus({ preventScroll: true });
});

confirmButton.addEventListener("click", () => {
  if (!latestPreview?.canShare) return;
  shareText.textContent = latestPreview.shareText;
  result.hidden = false;
  shareStatus.hidden = true;
  result.scrollIntoView({ behavior: "smooth", block: "start" });
});

async function copyResult() {
  await navigator.clipboard.writeText(latestPreview.shareText);
  setStatus("Текст скопирован.");
}

copyButton.addEventListener("click", async () => {
  try {
    await copyResult();
  } catch {
    setStatus("Не удалось скопировать текст. Выделите его вручную.", "error");
  }
});

shareButton.addEventListener("click", async () => {
  if (!latestPreview?.shareText) return;
  if (navigator.share) {
    try {
      await navigator.share({ text: latestPreview.shareText });
      return;
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  try {
    await copyResult();
    setStatus("Системная отправка недоступна — текст скопирован.");
  } catch {
    setStatus("Не удалось поделиться или скопировать текст.", "error");
  }
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js"));
}
