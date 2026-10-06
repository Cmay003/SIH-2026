#!/usr/bin/env node
// SANJEEVNI - manage dashboard / officer-page accounts.
//
//   node create_user.js add <username> [viewer|officer|admin]   (default: officer)
//   node create_user.js passwd <username>        reset password, signs them out everywhere
//   node create_user.js disable <username>       block login + end their sessions
//   node create_user.js enable <username>
//   node create_user.js unlock <username>        clear a failed-login lockout
//   node create_user.js list
//
// Passwords are typed (hidden) and confirmed - never passed as arguments,
// which would leave them in shell history.
const path = require("path");
const readline = require("readline");
const { DatabaseSync } = require("node:sqlite");
const { hashPassword, passwordProblem, initAuthTables, ROLES } = require("./auth");

const db = new DatabaseSync(path.join(__dirname, "sanjeevni.db"));
initAuthTables(db);

// ONE readline interface for the whole run, with incoming lines QUEUED.
// Piped input (echo pw | node create_user.js ...) arrives all at once:
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
    console.error(`No user '${username}'. See: node create_user.js list`);
    process.exit(1);
  }
  return user;
}

const endSessions = (userId) => db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);

async function main() {
  const [command, username, roleArg] = process.argv.slice(2);
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
      if (db.prepare("SELECT 1 FROM users WHERE username = ?").get(username)) {
        console.error(`User '${username}' already exists (use passwd to reset the password).`);
        process.exit(1);
      }
      const pw = await askNewPassword();
      db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)")
        .run(username, hashPassword(pw), role, new Date().toISOString());
      console.log(`Created ${role} '${username}'.`);
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
      const rows = db.prepare("SELECT username, role, active, last_login_at, locked_until FROM users ORDER BY username").all();
      if (!rows.length) console.log("No users yet. Create one: node create_user.js add <username> officer");
      for (const u of rows) {
        const locked = u.locked_until && new Date(u.locked_until) > new Date() ? " LOCKED" : "";
        console.log(`${u.username.padEnd(20)} ${u.role.padEnd(8)} ${u.active ? "active  " : "DISABLED"}${locked}  last login: ${u.last_login_at || "never"}`);
      }
      break;
    }
    default:
      console.log(require("fs").readFileSync(__filename, "utf8").split("\n").slice(1, 11).join("\n").replace(/^\/\/ ?/gm, ""));
  }
  rl.close();
}

main();
