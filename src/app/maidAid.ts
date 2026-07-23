import { calculateDay } from "../domain/calculations.js";
import { formatParsedDay, generateDraft } from "../domain/draft.js";
import { formatHours, formatMoney, formatTime, workTypeLabel } from "../domain/format.js";
import { parseDay, parseTimeAnswer } from "../domain/parser.js";
import type { BotResponse, ParsedDay, PendingState } from "../domain/types.js";
import type { Storage } from "../storage/storage.js";

const confirmButtons = [
  { id: "confirm", title: "Подтвердить" },
  { id: "correct", title: "Исправить текст" },
  { id: "cancel", title: "Отмена" },
];

function isoFromShortDate(value: string, now = new Date()): string | null {
  const match = value.match(/(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/);
  if (!match) return null;
  let year = match[3] ? Number(match[3]) : now.getFullYear();
  if (year < 100) year += 2000;
  const day = Number(match[1]);
  const month = Number(match[2]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function firstBlockingIssue(day: ParsedDay) {
  return day.issues.find((issue) =>
    ["missing_date", "missing_start", "missing_end", "missing_type", "overlap"].includes(issue.code),
  );
}

export class MaidAid {
  constructor(private readonly storage: Storage) {}

  async handle(userPhone: string, text: string, actionId?: string): Promise<BotResponse[]> {
    const normalized = text.trim();
    const command = (actionId ?? normalized).toLocaleLowerCase("ru");
    const pending = await this.storage.getPending(userPhone);

    if (command === "cancel" || command === "отмена") {
      await this.storage.savePending(userPhone, null);
      return [{ text: "Текущий ввод отменён." }];
    }
    if (command === "correct") {
      await this.storage.savePending(userPhone, {
        mode: "awaiting_replacement",
        kind: pending?.kind ?? "actual",
      });
      return [{ text: "Пришли исправленный текст целиком." }];
    }
    if (command === "confirm") return this.confirm(userPhone, pending);

    if (pending?.mode === "awaiting_answer" && pending.parsed && pending.awaiting) {
      return this.applyAnswer(userPhone, normalized, pending);
    }
    if (pending?.mode === "awaiting_actual" || pending?.mode === "awaiting_replacement") {
      const parsed = parseDay(normalized);
      parsed.kind = pending.kind;
      return this.stageParsed(userPhone, parsed);
    }

    if (command === "итог") {
      await this.storage.savePending(userPhone, { mode: "awaiting_actual", kind: "actual" });
      return [
        {
          text: [
            "Пришли фактический день одним сообщением.",
            "",
            "Например:",
            "19/07 изменения",
            "Eiffel 11:00-14:00 самостоятельно",
            "15:30-18:00 Opera ознакомление (Ана)",
            "Сушка Eiffel 3.90",
          ].join("\n"),
        },
      ];
    }
    if (command === "расписание") {
      await this.storage.savePending(userPhone, { mode: "awaiting_replacement", kind: "schedule" });
      return [{ text: "Вставь расписание целиком одним сообщением." }];
    }
    if (command === "баланс") return [await this.balanceResponse()];
    if (command === "история") return [await this.historyResponse()];
    if (command.startsWith("черновик")) return [await this.draftResponse(command)];
    if (command.startsWith("исправить")) {
      const dateIso = isoFromShortDate(command);
      if (!dateIso || !(await this.storage.getDay(dateIso))) {
        return [{ text: "Не нашёл сохранённый день. Используй формат: исправить 19/07" }];
      }
      await this.storage.savePending(userPhone, { mode: "awaiting_replacement", kind: "actual" });
      return [{ text: "Пришли исправленный фактический день целиком." }];
    }

    if (/\d{1,2}[./]\d{1,2}/.test(normalized)) {
      return this.stageParsed(userPhone, parseDay(normalized));
    }
    return [
      {
        text: [
          "Не понял сообщение.",
          "",
          "Команды: расписание, итог, баланс, история, исправить 19/07, черновик 19/07, отмена.",
        ].join("\n"),
      },
    ];
  }

  private async stageParsed(userPhone: string, parsed: ParsedDay): Promise<BotResponse[]> {
    if (!parsed.jobs.length) {
      return [{ text: "Не нашёл ни одной работы. Проверь текст и пришли его целиком ещё раз." }];
    }
    if (parsed.unparsedLines.length) {
      await this.storage.savePending(userPhone, {
        mode: "awaiting_replacement",
        kind: parsed.kind,
        parsed,
      });
      return [
        {
          text: `${formatParsedDay(parsed)}\n\nИсправь нераспознанные строки и пришли весь текст ещё раз.`,
          buttons: [{ id: "cancel", title: "Отмена" }],
        },
      ];
    }
    const issue = firstBlockingIssue(parsed);
    if (issue) {
      if (
        issue.jobIndex !== undefined &&
        (issue.code === "missing_end" || issue.code === "missing_start" || issue.code === "missing_type")
      ) {
        const field =
          issue.code === "missing_end" ? "end" : issue.code === "missing_start" ? "start" : "type";
        await this.storage.savePending(userPhone, {
          mode: "awaiting_answer",
          kind: parsed.kind,
          parsed,
          awaiting: { field, jobIndex: issue.jobIndex },
        });
        const job = parsed.jobs[issue.jobIndex]!;
        const question =
          field === "end"
            ? `Во сколько закончилась работа ${job.object}?`
            : field === "start"
              ? `Во сколько началась работа ${job.object}?`
              : `Какой тип работы был у ${job.object}: самостоятельно или ознакомление?`;
        return [{ text: `${formatParsedDay(parsed)}\n\n${question}` }];
      }
      await this.storage.savePending(userPhone, {
        mode: "awaiting_replacement",
        kind: parsed.kind,
        parsed,
      });
      return [
        {
          text: `${formatParsedDay(parsed)}\n\n${issue.message}. Пришли исправленный текст целиком.`,
          buttons: [{ id: "cancel", title: "Отмена" }],
        },
      ];
    }
    await this.storage.savePending(userPhone, { mode: "parsed", kind: parsed.kind, parsed });
    return [{ text: formatParsedDay(parsed), buttons: confirmButtons }];
  }

  private async applyAnswer(
    userPhone: string,
    answer: string,
    pending: PendingState,
  ): Promise<BotResponse[]> {
    const day = structuredClone(pending.parsed!);
    const target = day.jobs[pending.awaiting!.jobIndex];
    if (!target) return [{ text: "Не удалось найти работу. Пришли исправленный текст целиком." }];

    if (pending.awaiting!.field === "type") {
      if (/самостоятель|уборк/iu.test(answer)) target.workType = "independent";
      else if (/ознакомлен|знакомств/iu.test(answer)) target.workType = "orientation";
      else return [{ text: "Ответь «самостоятельно» или «ознакомление»." }];
    } else {
      const minutes = parseTimeAnswer(answer);
      if (minutes === null) return [{ text: "Не понял время. Напиши, например: 18:30" }];
      if (pending.awaiting!.field === "start") target.startMinutes = minutes;
      else {
        target.endMinutes = minutes;
        target.endInferred = false;
      }
    }
    day.issues = day.issues.filter(
      (issue) =>
        !(
          issue.jobIndex === pending.awaiting!.jobIndex &&
          ((pending.awaiting!.field === "end" && issue.code === "missing_end") ||
            (pending.awaiting!.field === "start" && issue.code === "missing_start") ||
            (pending.awaiting!.field === "type" && issue.code === "missing_type"))
        ),
    );
    if (
      target.startMinutes !== null &&
      target.endMinutes !== null &&
      target.endMinutes <= target.startMinutes
    ) {
      return [{ text: "Окончание должно быть позже начала. Введи корректное время." }];
    }
    return this.stageParsed(userPhone, day);
  }

  private async confirm(
    userPhone: string,
    pending: PendingState | null,
  ): Promise<BotResponse[]> {
    if (!pending?.parsed || pending.mode !== "parsed") {
      return [{ text: "Сейчас нечего подтверждать." }];
    }
    const settings = await this.storage.getSettings();
    const totals = calculateDay(pending.parsed, settings);
    await this.storage.saveDay({
      parsed: pending.parsed,
      totals,
      status: pending.kind,
      confirmedAt: new Date().toISOString(),
    });
    await this.storage.savePending(userPhone, null);
    if (pending.kind === "schedule") {
      return [{ text: `Расписание на ${pending.parsed.displayDate} сохранено.` }];
    }
    const balance = await this.storage.getBalance();
    return [
      {
        text: [
          `День ${pending.parsed.displayDate} сохранён.`,
          `Сегодня: ${formatHours(totals.minutes)}`,
          `Заработок: ${formatMoney(totals.incomeCents)}`,
          `Расходы: ${formatMoney(totals.expensesCents)}`,
        ].join("\n"),
      },
      { text: generateDraft(pending.parsed, settings, balance) },
    ];
  }

  private async balanceResponse(): Promise<BotResponse> {
    const balance = await this.storage.getBalance();
    return {
      text: [
        `Всего: ${formatHours(balance.minutes)}`,
        `Заработок: ${formatMoney(balance.incomeCents)}`,
        `Расходы: ${formatMoney(balance.expensesCents)}`,
      ].join("\n"),
    };
  }

  private async historyResponse(): Promise<BotResponse> {
    const days = await this.storage.listDays(10);
    if (!days.length) return { text: "История пока пустая." };
    return {
      text: days
        .map(
          (day) =>
            `${day.parsed.displayDate}: ${formatHours(day.totals.minutes)}, ${formatMoney(day.totals.incomeCents)}, расходы ${formatMoney(day.totals.expensesCents)} (${day.status === "actual" ? "факт" : "план"})`,
        )
        .join("\n"),
    };
  }

  private async draftResponse(command: string): Promise<BotResponse> {
    const dateIso = isoFromShortDate(command);
    if (!dateIso) return { text: "Укажи дату: черновик 19/07" };
    const day = await this.storage.getDay(dateIso);
    if (!day || day.status !== "actual") return { text: "Не нашёл подтверждённый факт за эту дату." };
    const settings = await this.storage.getSettings();
    const balance = await this.storage.getBalance();
    return { text: generateDraft(day.parsed, settings, balance) };
  }
}
