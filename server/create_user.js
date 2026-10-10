#!/usr/bin/env node
// SANJEEVNI - manage dashboard / officer-page accounts.
//
//   node server/create_user.js add <username> [viewer|officer|admin] [--phone +91XXXXXXXXXX]   (default: officer)
//   node server/create_user.js set-phone <username> <+91XXXXXXXXXX|none>   officer WhatsApp alerts
//   node server/create_user.js passwd <username>        reset password, signs them out everywhere
//   node server/create_user.js disable <username>       block login + end their sessions
//   node server/create_user.js enable <username>
//   node server/create_user.js unlock <username>        clear a failed-login lockout
//   node server/create_user.js list
//
// --phone / set-phone: an E.164 mobile number (country code first, e.g.
// +91 98765 43210) for officer WhatsApp alerts on confirmed HIGH/CRITICAL
// hazards and automatic sirens (officer_alerts.js). Officer/admin accounts
// only - a viewer never gets one. "none" removes it.
// Passwords are typed (hidden) and confirmed - never passed as arguments,
// which would leave them in shell history.
const path = require("path");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");
const { hashPassword, passwordProblem, initAuthTables, ROLES, normalizePhone, maskPhone, PHONE_ROLES } = require("./auth");

const db = new DatabaseSync(require("./paths").DB_PATH);
initAuthTables(db);

// ONE readline interface for the whole run, with incoming lines QUEUED.
// Piped input (echo pw | node server/create_user.js ...) arrives all at once:
// a per-prompt interface, or rl.question(), dropped every line that came
// in before the next prompt was asked, and the script silently exited.
const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let muted = false;
rl._writeToOutput = (text) => {
  if (!muted) rl.output.write(text); // hide what's typed while muted
};
const queuedLines = [];
const waitingForLine = [];
rl.on("line", (line) => {
  if (waitingForLine.length) waitingForLine.shift()(line);
  else queuedLines.push(line);
});
rl.on("close", () => {
  if (waitingForLine.length) {
    console.error("\nInput ended before a password was entered - nothing changed.");
    process.exit(1);
  }
});

async function askHidden(question) {
  rl.output.write(question);
  muted = true;
  const answer = queuedLines.length
    ? queuedLines.shift()
    : await new Promise((resolve) => waitingForLine.push(resolve));
  muted = false;
  rl.output.write("\n");
  return answer;
}

async function askNewPassword() {
  for (;;) {
    const pw = await askHidden("New password: ");
    const problem = passwordProblem(pw);
    if (problem) {
      console.log(problem);
      continue;
    }
    if ((await askHidden("Repeat password: ")) !== pw) {
      console.log("Passwords don't match - try again.");
      continue;
    }
    return pw;
  }
}

function findUser(username) {
  const user = db.prepare("SELECT * FROM users WHERE username = ?").get(username);
  if (!user) {
    console.error(`No user '${username}'. See: node server/create_user.js list`);
    process.exit(1);
  }
  return user;
}

const endSessions = (userId) => db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);

// Takes "--phone <number>" (or "--phone=<number>") out of the arguments.
function takePhoneOption(args) {
  const rest = [];
  let phone;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--phone") {
      phone = args[++i] ?? "";
    } else if (args[i].startsWith("--phone=")) {
      phone = args[i].slice("--phone=".length);
    } else {
      rest.push(args[i]);
    }
  }
  return { rest, phone };
}

function phoneOrExit(raw) {
  const phone = normalizePhone(raw);
  if (!phone) {
    console.error(`'${raw}' is not an international (E.164) number: start with + and the country code, e.g. +91 98765 43210.`);
    process.exit(1);
  }
  return phone;
}

async function main() {
  const { rest: args, phone: phoneArg } = takePhoneOption(process.argv.slice(2));
  const [command, username, roleArg] = args;
  switch (command) {
    case "add": {
      if (!username || !/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
        console.error("Username: 3-32 characters, letters/digits/._- only.");
        process.exit(1);
      }
      const role = roleArg || "officer";
      if (!ROLES.includes(role)) {
        console.error(`Role must be one of: ${ROLES.join(", ")}`);
        process.exit(1);
      }
      let phone = null;
      if (phoneArg !== undefined) {
        if (!PHONE_ROLES.has(role)) {
          console.error("Only officer and admin accounts get WhatsApp alerts - a viewer cannot have a phone number.");
          process.exit(1);
        }
        phone = phoneOrExit(phoneArg);
      }
      if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) {
        console.error(`User '${username}' already exists (use passwd to reset the password, set-phone for the number).`);
        process.exit(1);
      }
      const pw = await askNewPassword();
      db.prepare("INSERT INTO users (username, password_hash, role, created_at, phone) VALUES (?, ?, ?, ?, ?)")
        .run(username, hashPassword(pw), role, new Date().toISOString(), phone);
      console.log(`Created ${role} '${username}'${phone ? ` with WhatsApp alerts to ${maskPhone(phone)}` : ""}.`);
      break;
    }
    case "set-phone": {
      const user = findUser(username);
      const raw = args.length > 2 ? args.slice(2).join(" ") : phoneArg; // "+91 98765 43210" unquoted is 3 args
      if (raw === undefined) {
        console.error("Usage: node server/create_user.js set-phone <username> <+91XXXXXXXXXX|none>");
        process.exit(1);
      }
      if (/^(none|off|-)$/i.test(raw)) {
        db.prepare("UPDATE users SET phone = NULL WHERE id = ?").run(user.id);
        console.log(`Removed the phone number of '${user.username}' - no more WhatsApp alerts.`);
        break;
      }
      if (!PHONE_ROLES.has(user.role)) {
        console.error(`'${user.username}' is a ${user.role}: only officer and admin accounts get WhatsApp alerts.`);
        process.exit(1);
      }
      const phone = phoneOrExit(raw);
      db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone, user.id);
      console.log(`WhatsApp alerts for '${user.username}' go to ${maskPhone(phone)}.`);
      break;
    }
    case "passwd": {
      const user = findUser(username);
      const pw = await askNewPassword();
      db.prepare("UPDATE users SET password_hash = ?, failed_attempts = 0, locked_until = NULL WHERE id = ?")
        .run(hashPassword(pw), user.id);
      endSessions(user.id);
      console.log(`Password changed for '${user.username}'; existing sessions signed out.`);
      break;
    }
    case "disable":
    case "enable": {
      const user = findUser(username);
      db.prepare("UPDATE users SET active = ? WHERE id = ?").run(command === "enable" ? 1 : 0, user.id);
      if (command === "disable") endSessions(user.id);
      console.log(`${command === "enable" ? "Enabled" : "Disabled"} '${user.username}'.`);
      break;
    }
    case "unlock": {
      const user = findUser(username);
      db.prepare("UPDATE users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(user.id);
      console.log(`Unlocked '${user.username}'.`);
      break;
    }
    case "list": {
      const rows = db.prepare("SELECT username, role, active, last_login_at, locked_until, phone FROM users ORDER BY username").all();
      if (!rows.length) console.log("No users yet. Create one: node server/create_user.js add <username> officer");
      for (const u of rows) {
        const locked = u.locked_until && new Date(u.locked_until) > new Date() ? " LOCKED" : "";
        const phone = u.phone ? `  phone: ${maskPhone(u.phone)}` : "";
        console.log(`${u.username.padEnd(20)} ${u.role.padEnd(8)} ${u.active ? "active  " : "DISABLED"}${locked}  last login: ${u.last_login_at || "never"}${phone}`);
      }
      break;
    }
    default:
      console.log(require("fs").readFileSync(__filename, "utf8").split("\n").slice(1, 17).join("\n").replace(/^\/\/ ?/gm, ""));
  }
  rl.close();
}

main();
