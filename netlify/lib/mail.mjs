// Same · email, free: sends through your own Gmail (about 500 emails a day).
// Needs two environment variables in Netlify: GMAIL_USER (you@gmail.com) and GMAIL_APP_PASSWORD (a Google "app password").
// Optional: OWNER_EMAIL (where new-order emails go; defaults to GMAIL_USER), MAIL_FROM_NAME (defaults to "Same · Creative Studio").
// Without them, nothing is sent and nothing breaks.
import nodemailer from "nodemailer";

export const mailReady = () => !!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
let tx;
function transport() {
  if (!tx) tx = nodemailer.createTransport({ host: "smtp.gmail.com", port: 465, secure: true, auth: { user: process.env.GMAIL_USER, pass: String(process.env.GMAIL_APP_PASSWORD).replace(/\s+/g, "") } });
  return tx;
}
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function shell(title, bodyHtml, button) {
  return `<!doctype html><html><body style="margin:0;background:#f4e9e1;font-family:Helvetica,Arial,sans-serif;color:#0d0d0d">
  <div style="max-width:560px;margin:0 auto;padding:28px 18px">
    <div style="font:800 22px/1 Arial Black,Helvetica,Arial,sans-serif;letter-spacing:-.02em">Same.</div>
    <div style="font:600 11px/1 Helvetica,Arial,sans-serif;letter-spacing:.12em;text-transform:uppercase;color:#4d4741;margin-top:6px">Creative Studio</div>
    <div style="background:#1be349;border-radius:24px;padding:26px 22px;margin-top:22px">
      <div style="font:800 28px/1.05 Arial Black,Helvetica,Arial,sans-serif;letter-spacing:-.02em">${esc(title)}</div>
      <div style="font-size:15px;line-height:1.5;margin-top:12px">${bodyHtml}</div>
      ${button ? `<a href="${esc(button.url)}" style="display:inline-block;margin-top:20px;background:#0d0d0d;color:#f4e9e1;text-decoration:none;font-weight:700;padding:14px 24px;border-radius:100px">${esc(button.label)}</a>` : ""}
    </div>
    <p style="font-size:12px;color:#4d4741;margin-top:18px">Same · Creative Studio · Reply to this email if anything is off. A real person answers.</p>
  </div></body></html>`;
}

export async function send({ to, subject, title, html, button, text }) {
  if (!mailReady() || !to) return false;
  try {
    await transport().sendMail({
      from: `"${process.env.MAIL_FROM_NAME || "Same · Creative Studio"}" <${process.env.GMAIL_USER}>`,
      to, subject, text: text || subject, html: shell(title || subject, html || esc(text || ""), button),
    });
    return true;
  } catch (e) { console.log("mail failed", e.message); return false; }
}

export function ownerEmail() { return process.env.OWNER_EMAIL || process.env.GMAIL_USER || ""; }

export async function mailNewOrder(rec, origin) {
  const rows = [
    ["Order", rec.order], ["Plan", rec.plan], ["Brand", rec.place], ["From", `${rec.name} · ${rec.email}`],
    ["Link", rec.link], ["Idea", rec.brief], ["Notes", rec.notes], ["Files", rec.files],
  ].filter(([, v]) => v).map(([k, v]) => `<b>${esc(k)}:</b> ${esc(v).replace(/\n/g, "<br>")}`).join("<br><br>");
  return send({ to: ownerEmail(), subject: `New order · ${rec.place || rec.email} · ${rec.plan || ""}`, title: "New order. Clock is running.", html: rows, button: { label: "Open your done page", url: `${origin}/done.html` } });
}

export async function mailReadyToClient(rec, origin) {
  return send({ to: rec.email, subject: "Your photos are ready · Same", title: "Your photos are ready.",
    html: `${esc(rec.name ? rec.name + ", h" : "H")}ere they are: full quality, sized for every platform. Everything is waiting in your space.`,
    button: { label: "Open your space", url: `${origin}/account.html` } });
}

export async function mailWelcome(u, origin) {
  return send({ to: u.email, subject: "Welcome to Same", title: "This is your space.",
    html: "Every photo and video we make for you lands here, ready to download. No more digging through emails.", button: { label: "Open your space", url: `${origin}/account.html` } });
}
