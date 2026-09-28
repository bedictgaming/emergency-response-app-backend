import fs from "fs";
import path from "path";

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
})[character]!);

export function renderTemplate(templatePath: string, vars: Record<string, string>): string {
  const absolute = path.isAbsolute(templatePath)
    ? templatePath
    : path.join(process.cwd(), "src/services/mail/templates", templatePath);
  let html = fs.readFileSync(absolute, "utf8");
  for (const [key, value] of Object.entries(vars)) {
    const re = new RegExp(`{{\\s*${key}\\s*}}`, "g");
    html = html.replace(re, () => escapeHtml(value));
  }
  return html;
}
