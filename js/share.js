import { shareMessage } from "./compare.js";

export function buildSharePayload(maxKmh, comparison, tableName) {
  const text = shareMessage(maxKmh, comparison, tableName);
  return { text, url: location.href.split("#")[0] };
}

export async function shareNative(payload) {
  if (navigator.share) {
    await navigator.share({ title: "ריצת שיא", text: payload.text, url: payload.url });
    return true;
  }
  return false;
}

export function whatsappUrl(payload) {
  const q = encodeURIComponent(`${payload.text}\n${payload.url}`);
  return `https://wa.me/?text=${q}`;
}

export function twitterUrl(payload) {
  const q = encodeURIComponent(payload.text);
  const u = encodeURIComponent(payload.url);
  return `https://twitter.com/intent/tweet?text=${q}&url=${u}`;
}

export async function copyText(text) {
  await navigator.clipboard.writeText(text);
}

export function drawShareCard(canvas, { maxKmh, playerName, tableTitle, cheat, shareLine }) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width;
  const h = canvas.height;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, "#07080c");
  g.addColorStop(0.55, "#10261a");
  g.addColorStop(1, "#0b1220");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = "#b6ff3b";
  ctx.font = "700 28px sans-serif";
  ctx.textAlign = "right";
  ctx.direction = "rtl";
  ctx.fillText("Sprint Max", w - 40, 70);

  ctx.fillStyle = "#e8ffe8";
  ctx.font = "800 92px sans-serif";
  ctx.fillText(`${Number(maxKmh).toFixed(1)}`, w - 40, 190);
  ctx.font = "600 28px sans-serif";
  ctx.fillStyle = "#9dcc9d";
  ctx.fillText("קמ״ש מקסימום", w - 40, 230);

  ctx.fillStyle = "#fff";
  ctx.font = "600 26px sans-serif";
  const line = cheat
    ? "הריצה לא אושרה (חשד לרכב)"
    : shareLine || `אתה יותר מהיר מ-${playerName || "הטבלה"}. מהירות הריצה המקסימאלית היא: ${Number(maxKmh).toFixed(1)}`;
  wrapText(ctx, line, w - 40, 300, w - 80, 36);

  ctx.font = "400 20px sans-serif";
  ctx.fillStyle = "#b6d9b6";
  ctx.fillText(tableTitle || "", w - 40, h - 50);
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(" ");
  let line = "";
  let yy = y;
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x, yy);
      line = word;
      yy += lineHeight;
    } else {
      line = test;
    }
  }
  if (line) ctx.fillText(line, x, yy);
}

export function canvasPng(canvas) {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/png"));
}
