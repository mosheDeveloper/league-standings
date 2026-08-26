import { shareMessage } from "./compare.js";

export const INVITE =
  "רוצים לדעת אם אתם יותר מהירים מהשחקנים שאתם אוהבים? מדדו גם אתם ב־Sprint Max.";

export function appUrl() {
  try {
    return location.href.split("#")[0];
  } catch {
    return "https://sprintmax.app";
  }
}

export function buildSharePayload(maxKmh, comparison, tableName) {
  const line = shareMessage(maxKmh, comparison, tableName);
  const url = appUrl();
  const text = `${line}\n\n${INVITE}\n${url}`;
  return { line, text, url };
}

export async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

export function canvasPng(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}

export async function canvasFile(canvas, name = "sprint-max.png") {
  const blob = await canvasPng(canvas);
  return new File([blob], name, { type: "image/png" });
}

function openUrl(url) {
  window.open(url, "_blank", "noopener");
}

async function shareFiles({ title, text, url, canvas }) {
  const file = await canvasFile(canvas);
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ title, text, url, files: [file] });
    return "files";
  }
  if (navigator.share) {
    await navigator.share({ title, text, url });
    return "text";
  }
  return null;
}

function downloadCard(canvas) {
  const a = document.createElement("a");
  a.href = canvas.toDataURL("image/png");
  a.download = "sprint-max-share.png";
  a.click();
}

/**
 * Share to a chosen network. Instagram / TikTok have no public web composer,
 * so we send the story image via the system share sheet (or download + caption).
 */
export async function shareToPlatform(platform, payload) {
  const { text, url, line, canvas } = payload;
  const title = "Sprint Max";

  if (platform === "system") {
    const how = await shareFiles({ title, text, url, canvas });
    if (!how) {
      await copyText(text);
      return "copied";
    }
    return how;
  }

  if (platform === "whatsapp") {
    openUrl(`https://wa.me/?text=${encodeURIComponent(text)}`);
    return "open";
  }

  if (platform === "telegram") {
    openUrl(`https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`);
    return "open";
  }

  if (platform === "x") {
    openUrl(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}`);
    return "open";
  }

  if (platform === "facebook") {
    openUrl(
      `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}&quote=${encodeURIComponent(line + "\n\n" + INVITE)}`
    );
    return "open";
  }

  if (platform === "messenger") {
    openUrl(`https://www.facebook.com/dialog/send?link=${encodeURIComponent(url)}&redirect_uri=${encodeURIComponent(url)}`);
    return "open";
  }

  if (platform === "copy") {
    await copyText(text);
    return "copied";
  }

  if (platform === "save") {
    downloadCard(canvas);
    return "saved";
  }

  // Instagram, TikTok, Stories: image-first
  if (platform === "instagram" || platform === "tiktok" || platform === "stories") {
    try {
      const how = await shareFiles({ title, text, url, canvas });
      if (how === "files") return how;
      downloadCard(canvas);
      await copyText(text);
      return "download-copy";
    } catch (err) {
      if (err?.name === "AbortError") return "aborted";
      downloadCard(canvas);
      await copyText(text);
      return "download-copy";
    }
  }

  return "noop";
}

export function drawShareCard(canvas, data) {
  drawStoryCard(canvas, data);
}

/** 9:16 story card — Instagram / TikTok / WhatsApp status. */
export function drawStoryCard(canvas, { maxKmh, playerName, tableTitle, cheat, shareLine }) {
  const w = 1080;
  const h = 1920;
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");

  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, "#0a1f14");
  bg.addColorStop(0.45, "#07140e");
  bg.addColorStop(1, "#05070a");
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = "rgba(200,255,61,0.16)";
  ctx.beginPath();
  ctx.arc(860, 220, 340, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "rgba(94,234,212,0.12)";
  ctx.beginPath();
  ctx.arc(160, 1680, 280, 0, Math.PI * 2);
  ctx.fill();

  ctx.textAlign = "center";
  ctx.direction = "rtl";
  ctx.fillStyle = "#c8ff3d";
  ctx.font = "800 36px Heebo, sans-serif";
  ctx.fillText("SPRINT MAX", w / 2, 160);

  ctx.fillStyle = "#9aa6c8";
  ctx.font = "600 28px Heebo, sans-serif";
  ctx.fillText("שיא הריצה שלי", w / 2, 210);

  ctx.fillStyle = "#f4ffe8";
  ctx.font = "800 220px Heebo, sans-serif";
  ctx.fillText(Number(maxKmh).toFixed(1), w / 2, 520);
  ctx.fillStyle = "#c8ff3d";
  ctx.font = "800 48px Heebo, sans-serif";
  ctx.fillText("קמ״ש מקסימום", w / 2, 590);

  const boxY = 680;
  roundRect(ctx, 80, boxY, w - 160, 280, 40);
  ctx.fillStyle = "rgba(255,255,255,0.06)";
  ctx.fill();
  ctx.fillStyle = "#ffffff";
  ctx.font = "700 40px Heebo, sans-serif";
  const headline = cheat
    ? "הריצה לא אושרה — חשד לרכב"
    : shareLine || `אתה יותר מהיר מ-${playerName || "הטבלה"}`;
  wrapCentered(ctx, headline, w / 2, boxY + 80, w - 240, 52);

  ctx.fillStyle = "#9aa6c8";
  ctx.font = "600 28px Heebo, sans-serif";
  ctx.fillText(tableTitle || "", w / 2, boxY + 240);

  roundRect(ctx, 80, 1060, w - 160, 220, 40);
  ctx.fillStyle = "#c8ff3d";
  ctx.fill();
  ctx.fillStyle = "#08100a";
  ctx.font = "800 40px Heebo, sans-serif";
  wrapCentered(ctx, "מדדו גם אתם — מי יותר מהיר ממבאפה?", w / 2, 1140, w - 240, 48);

  ctx.fillStyle = "#d7e0ff";
  ctx.font = "600 30px Heebo, sans-serif";
  ctx.fillText("Sprint Max  ·  הטלפון בכיס. רצים. משווים.", w / 2, 1420);

  ctx.fillStyle = "#5eead4";
  ctx.font = "700 26px Heebo, sans-serif";
  ctx.fillText(INVITE, w / 2, 1760);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function wrapCentered(ctx, text, x, y, maxWidth, lineHeight) {
  const words = String(text).split(" ");
  let line = "";
  let yy = y;
  const lines = [];
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else line = test;
  }
  if (line) lines.push(line);
  lines.forEach((l, i) => ctx.fillText(l, x, yy + i * lineHeight));
}
