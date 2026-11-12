// Lightweight, zero-dependency SMTP email client using Node standard library (node:tls, node:net).
// Dispatches notifications for:
// 1. New Issue / Feature Request tickets from users to the Administrator.
// 2. Password reset links to users.
import tls from "node:tls";
import net from "node:net";

export const getAdminEmail = () => process.env.HIVEMIND_ADMIN_EMAIL || "developerteam@themavericksindia.com";

export async function sendEmail({ to, subject, text, html = null }) {
  const host = process.env.SMTP_HOST;
  const port = +process.env.SMTP_PORT || (process.env.SMTP_SECURE === "true" ? 465 : 587);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || `"HiveMind Intelligence" <${user || "notifications@hivemind.local"}>`;

  if (!host || !user || !pass) {
    // Graceful offline / unconfigured mode: log clearly for admins
    console.log(`[HiveMind Email Dispatch (Simulated / Local Mode)]`);
    console.log(`  To: ${to}`);
    console.log(`  Subject: ${subject}`);
    console.log(`  Body:\n${text}`);
    return { ok: true, simulated: true, to, subject };
  }

  const boundary = "====_HiveMind_" + Date.now() + "_====";
  const rawMessage = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `MIME-Version: 1.0`,
    html
      ? `Content-Type: multipart/alternative; boundary="${boundary}"\r\n\r\n` +
        `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n\r\n` +
        `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\n\r\n${html}\r\n\r\n` +
        `--${boundary}--`
      : `Content-Type: text/plain; charset=utf-8\r\n\r\n${text}`,
    `.`
  ].join("\r\n");

  return new Promise((resolve, reject) => {
    let socket;
    let step = 0;
    let buffer = "";

    const finish = (err, result) => {
      try { socket?.end(); } catch {}
      if (err) reject(err);
      else resolve(result);
    };

    const isSecure = port === 465 || process.env.SMTP_SECURE === "true";
    const connectOptions = { host, port, timeout: 15000 };

    const onConnect = () => {
      // Wait for server greeting (220)
    };

    if (isSecure) {
      socket = tls.connect(connectOptions, onConnect);
    } else {
      socket = net.connect(connectOptions, onConnect);
    }

    socket.setEncoding("utf8");
    socket.setTimeout(15000, () => finish(new Error("SMTP connection timed out")));

    const sendCmd = (cmd) => {
      socket.write(cmd + "\r\n");
    };

    socket.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\r\n");
      buffer = lines.pop(); // keep partial

      for (const line of lines) {
        if (!line) continue;
        const code = parseInt(line.slice(0, 3), 10);
        // Multiline response check: format is "250-something", last line is "250 something"
        if (line.charAt(3) === "-") continue;

        if (code >= 400) {
          return finish(new Error(`SMTP Error (${code}): ${line}`));
        }

        switch (step) {
          case 0: // Server greeting (220)
            if (code === 220) {
              step = 1;
              sendCmd("EHLO hivemind.local");
            }
            break;
          case 1: // EHLO response (250)
            if (code === 250) {
              step = 2;
              sendCmd("AUTH LOGIN");
            }
            break;
          case 2: // 334 Username challenge
            if (code === 334) {
              step = 3;
              sendCmd(Buffer.from(user).toString("base64"));
            }
            break;
          case 3: // 334 Password challenge
            if (code === 334) {
              step = 4;
              sendCmd(Buffer.from(pass).toString("base64"));
            }
            break;
          case 4: // 235 Authentication succeeded
            if (code === 235) {
              step = 5;
              const senderMatch = from.match(/<([^>]+)>/);
              const senderAddr = senderMatch ? senderMatch[1] : user;
              sendCmd(`MAIL FROM:<${senderAddr}>`);
            }
            break;
          case 5: // 250 OK Mail from
            if (code === 250) {
              step = 6;
              sendCmd(`RCPT TO:<${to}>`);
            }
            break;
          case 6: // 250 OK Recipient
            if (code === 250) {
              step = 7;
              sendCmd("DATA");
            }
            break;
          case 7: // 354 Start mail input
            if (code === 354) {
              step = 8;
              socket.write(rawMessage + "\r\n");
            }
            break;
          case 8: // 250 OK Message accepted
            if (code === 250) {
              step = 9;
              sendCmd("QUIT");
              finish(null, { ok: true, delivered: true, to, subject });
            }
            break;
        }
      }
    });

    socket.on("error", (err) => finish(err));
  });
}

