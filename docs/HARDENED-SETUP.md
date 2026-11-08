# Hardened setup

The safety promise ("no change without a human approving it outside the model") holds on its own only when the AI has **no shell and no control of your browser** (for example Claude Desktop without shell or browser-control extensions).

Claude Code, Cursor and similar tools give the AI a terminal **on your OS user**. A program running as you can read the settings folder (the store, the encryption key in the Keychain / keyring / key file), start its own copy of the server with changed settings, edit `policy.yaml`, and fake a terminal for `approve`. A browser-control tool (Claude in Chrome, Playwright, computer-use) can read the approval page, code included.

The hardened setup narrows this: **the server and its settings folder run as a different OS user (or in a container)**, your user can start only `serve` as that user, `approval_mode` is `code_only`, and `open_browser` is `false`.

**Its limit, plainly:** an AI with a shell on your user can change your shell startup files (`.zshrc`, `.bashrc`, aliases, `PATH`). It can then fake `sudo` and capture the password you type, or show you a fake `approvals open`. It can also race the temporary copy `sudoedit` makes of `policy.yaml`. So against an AI agent with a shell, the separate user holds **only if the human steps** (your password, `approvals open`, policy edits) **happen in a session the AI can't change**: another OS account's login session, SSH from another device, or with the AI agent itself sandboxed. See [Where you do the human steps](#where-you-do-the-human-steps). The same applies to the setup itself: an admin password typed into a terminal the AI can change gives it root.

> Status: these recipes follow each tool's documentation. They have not yet been run end to end on every OS by the maintainers. Try them with a Google Ads **test account** first, and run `doctor` as the service user.

> Built from source instead of npm? Replace `npm install ... perfoads-mcp@<version>` below with that build copied into the root-owned folder, and use its `packages/cli/bin/perfoads-mcp.js` as the entry point.

## The rules every recipe follows

1. **A service user** (here `perfoadsmcp`) owns the settings folder; its home is private (`chmod 700`).
2. **Your user can start exactly one command as that user without a password**: `... serve`. Nothing else (no shell, no `init`, no `approve`, no arguments of its choosing, no environment variables).
3. **Code and Node.js are not writable by your user.** Otherwise the AI could change the program the service user runs. Install Node.js system-wide (root/Administrator-owned, e.g. the nodejs.org installer; not a Homebrew or nvm copy in your home) and the server into a root-owned folder.
4. **Human-only steps** (sign-in, approving, editing the policy) run as the service user and need a password or a key the AI does not have. Type them only in a session the AI can't change ([below](#where-you-do-the-human-steps)): a terminal on your own user is not one while an AI agent has a shell there.
5. **`{"approval_mode": "code_only", "open_browser": false}`** in the service user's `config.json`: the server never starts a browser itself, the approval page never has an Approve button, and approval always needs its code typed by you in a terminal running as the service user.

## Approval modes

`config.json` in the settings folder, read when the server starts. For the hardened setup:

```json
{ "approval_mode": "code_only", "open_browser": false }
```

- `approval_mode: auto` (default): apps with MCP forms ask you to type the code from the approval page; apps without forms show an **Approve** button on the page.
- `approval_mode: code_only`: never a button. Apps with forms ask for the code; apps without forms approve in a terminal (`approve <id>` or `approvals open <id>`).
- `open_browser: true` (default): `apply_change` starts the OS browser opener with the page link. `false`: the server never starts an opener and no AI app form ever asks for the code; `apply_change` answers that a person must run `approvals open <change_id>` in a terminal as the OS user the server runs as, and the code is typed there. If such a page is already open (from another `apply_change` or a terminal), every server process waits for it instead of replacing it.
- A `config.json` that can't be read, or holds another value, means the stricter setting (`code_only`, no opener).

**Why `open_browser: false` under a service user.** With the default, the server (running as the service user) starts the browser opener itself. Depending on the OS that may fail, or start, report success and show nothing on your desktop. Either way the AI is then told to have you type the code via `approve <id>` - which, run as **your** user, reads your own (empty or old) settings folder, not the service user's. And while the opener runs, the page link is on its command line, visible in `ps` to your user, and so to the AI. With `open_browser: false` no link is ever on a command line, and the AI always gets the right instruction.

**How you approve in the hardened setup:** from a session the AI can't change ([Where you do the human steps](#where-you-do-the-human-steps)), with the pinned, root-owned install from the recipe below (`$SERVER` and `$SVC_HOME` are set in steps 1 and 2):

```sh
sudo -u perfoadsmcp -H /usr/bin/env -i HOME="$SVC_HOME" PATH=/usr/bin:/bin /usr/local/bin/node "$SERVER" approvals open <change_id>
```

`/usr/bin/env -i` starts the command with an empty environment plus the two values given, so nothing from your shell (or set by the AI in it: `PATH`, `NODE_OPTIONS`, `PERFOADS_MCP_HOME`, ...) reaches the service user's process. Every command below uses the same form.

It prints the page address **to your terminal only**; open it, check the change, and type the code into the same terminal. Then tell the AI to call `apply_change` again. Container: `sudo docker run -it --rm --network host -v perfoads-mcp-data:/data perfoads-mcp approvals open <change_id>`. SSH recipe: run `approvals open <change_id>` in a session as the service user.

Don't use `npx` here: it looks programs and packages up through your environment and fetches whatever version npm serves at that moment. The pinned, root-owned install is the one to run.

## Where you do the human steps

Pick one. Each keeps your password, the approval code and the policy edit away from anything the AI can change.

**(a) Another device, SSH into the service user (forced command).** Your phone or another computer holds a key that can only run `approvals open`. The service user needs a login shell for this (Linux recipe below: `sudo usermod -s /bin/sh perfoadsmcp`) and SSH must allow it (macOS: Remote Login for `perfoadsmcp`). On the other device: `ssh-keygen -t ed25519 -f ~/.ssh/perfoads_approve`. In the service user's `~/.ssh/authorized_keys`, one line:

```
restrict,pty,command="/usr/local/bin/node /opt/perfoads-mcp/node_modules/perfoads-mcp/bin/perfoads-mcp.js approvals open \"$SSH_ORIGINAL_COMMAND\"" ssh-ed25519 AAAA... perfoads-approve
```

To approve, from the other device: `ssh -t -i ~/.ssh/perfoads_approve perfoadsmcp@<this computer> <change_id>`. The SSH session shows the change: check it there (that copy is out of the AI's reach). Open the printed page address in the browser on the computer the server runs on to read the code, and type the code into the SSH session. Seeing the code doesn't let the AI approve: with `code_only` it can only be typed in a terminal as the service user. Keep the key only on that device. For policy edits use (b) or (c).

**(b) Sandbox the AI agent.** If the agent can't write your dotfiles, it can't fake `sudo`, and your own terminal is safe again. Options: Claude Code's sandbox (`/sandbox`; file writes limited to the project folder; also turn off its fallback to unsandboxed commands, `sandbox.allowUnsandboxedCommands: false` - check the Claude Code docs for your version); a dev container or VM for the agent, with the MCP server reached over SSH (the [SSH recipe](#any-os-windows-too-separate-user--ssh-forced-command), host `host.docker.internal` from a container); or a separate OS user for the **agent** (run Claude Code / Cursor as `aiagent`, and write the sudo rule for `aiagent` instead of `yourname`). Your own user then does the human steps as written.

**(c) macOS: a separate admin account's login session.** System Settings > Users & Groups > Add User: an Administrator, e.g. `approver`. Switch to it with Fast User Switching (Control Center > your name > `approver`): the login window is drawn by macOS, not by your shell. In that account's Terminal run the step 6 commands (`approvals open`, `sudoedit`), and open the page in that account's browser (`127.0.0.1` is reachable across accounts). Your user can't write `approver`'s files. Best, also make your daily account a Standard user, so it has no admin password to capture.

## macOS and Linux: separate user + sudo

### 1. Create the service user

macOS:

```sh
sudo sysadminctl -addUser perfoadsmcp -fullName "PerfoAds MCP service" -password -
sudo chmod 700 ~perfoadsmcp
```

Linux:

```sh
sudo useradd --system --create-home --home-dir /var/lib/perfoadsmcp --shell /usr/sbin/nologin perfoadsmcp
sudo chmod 700 /var/lib/perfoadsmcp
```

Its home is used as `$SVC_HOME` below:

```sh
SVC_HOME=~perfoadsmcp    # the home folder of perfoadsmcp (macOS and Linux)
```

### 2. Install Node.js and the server, root-owned

Check `ls -l "$(command -v node)"`: the owner must be `root`, not you. If it is yours (Homebrew, nvm), install Node.js 22.13+ system-wide (nodejs.org installer on macOS, your distribution or NodeSource on Linux) and use its full path below (`/usr/local/bin/node` or `/usr/bin/node`).

```sh
sudo mkdir -p /opt/perfoads-mcp
sudo npm install --prefix /opt/perfoads-mcp perfoads-mcp@<version>
```

The entry point is then (used as `$SERVER` below; adjust the Node path too if yours is `/usr/bin/node`):

```sh
SERVER=/opt/perfoads-mcp/node_modules/perfoads-mcp/bin/perfoads-mcp.js
```

Pin a version; update deliberately with the same command.

### 3. Sign in as the service user

```sh
sudo -u perfoadsmcp -H /usr/bin/env -i HOME="$SVC_HOME" PATH=/usr/bin:/bin PERFOADS_MCP_KEY_BACKEND=file /usr/local/bin/node "$SERVER" init
```

The service user has no Keychain or keyring session, so the key goes into an owner-only key file in its settings folder. `init` prints Google's sign-in link; open it in your browser (the answer comes back to `127.0.0.1`, which works across users).

Then set the approval mode and your policy:

```sh
sudo -u perfoadsmcp -H /usr/bin/env -i HOME="$SVC_HOME" PATH=/usr/bin:/bin /bin/sh -c 'umask 077; printf "%s\n" "{\"approval_mode\":\"code_only\",\"open_browser\":false}" > "$HOME/.config/perfoads-mcp/config.json"'
sudo -u perfoadsmcp -H /usr/bin/env -i HOME="$SVC_HOME" PATH=/usr/bin:/bin /usr/bin/touch "$SVC_HOME/.config/perfoads-mcp/policy.yaml"
SUDO_EDITOR=/usr/bin/vi sudoedit -u perfoadsmcp "$SVC_HOME/.config/perfoads-mcp/policy.yaml"
```

`sudoedit` copies the file, runs the editor as **you** on the copy, and writes it back as the service user: the editor never runs as the service user. The copy sits where your user can write, so an AI running as you can change it before it is written back: edit the policy only from a session the AI can't change ([Where you do the human steps](#where-you-do-the-human-steps)). Name the editor by absolute path (`SUDO_EDITOR=/usr/bin/vi`, `/usr/bin/nano`, ...) so a changed `EDITOR`, `VISUAL` or `PATH` in your shell can't pick another program.

### 4. Allow exactly one command

`sudo visudo -f /etc/sudoers.d/perfoads-mcp` (replace `yourname` and the paths):

```
Defaults>perfoadsmcp always_set_home, env_reset, secure_path="/usr/bin:/bin"
yourname ALL=(perfoadsmcp) NOPASSWD: /usr/local/bin/node /opt/perfoads-mcp/node_modules/perfoads-mcp/bin/perfoads-mcp.js serve
```

Because the rule lists the arguments, sudo allows only that exact command line. `env_reset` (on by default) drops most of your environment, so `PERFOADS_MCP_HOME` and other `PERFOADS_MCP_*` settings don't pass - but it is **not** an empty environment: depending on the sudo build and its configuration, `PATH` (unless `secure_path` is set), `TZ`, `LANG`/`LC_*`, `TERM`, and on some systems `EDITOR` and `VISUAL` are kept. Check yours as root with `sudo -V` (look for "Environment variables to preserve", "Environment variables to check" and the `secure_path` line). The `secure_path` default above fixes `PATH`; the server also resets its own `PATH` at start and never looks a program up through it (browser opener, keychain tools: absolute system paths only). Keep sudo's default per-terminal password cache; never add `NOPASSWD: ALL`.

### 5. Point the AI app at it

```json
{
  "mcpServers": {
    "perfoads-mcp": {
      "command": "sudo",
      "args": [
        "-n",
        "-u",
        "perfoadsmcp",
        "/usr/local/bin/node",
        "/opt/perfoads-mcp/node_modules/perfoads-mcp/bin/perfoads-mcp.js",
        "serve"
      ]
    }
  }
}
```

Claude Code: `claude mcp add --scope user perfoads-mcp -- sudo -n -u perfoadsmcp /usr/local/bin/node /opt/perfoads-mcp/node_modules/perfoads-mcp/bin/perfoads-mcp.js serve`

### 6. Approve, check, change the policy (you, from a session the AI can't change)

```sh
sudo -u perfoadsmcp -H /usr/bin/env -i HOME="$SVC_HOME" PATH=/usr/bin:/bin /usr/local/bin/node "$SERVER" approvals open <change_id>   # page address + code prompt
sudo -u perfoadsmcp -H /usr/bin/env -i HOME="$SVC_HOME" PATH=/usr/bin:/bin /usr/local/bin/node "$SERVER" reject <change_id>
sudo -u perfoadsmcp -H /usr/bin/env -i HOME="$SVC_HOME" PATH=/usr/bin:/bin /usr/local/bin/node "$SERVER" doctor
sudo -u perfoadsmcp -H /usr/bin/env -i HOME="$SVC_HOME" PATH=/usr/bin:/bin /usr/local/bin/node "$SERVER" policy show
SUDO_EDITOR=/usr/bin/vi sudoedit -u perfoadsmcp "$SVC_HOME/.config/perfoads-mcp/policy.yaml"
```

Remove your user's old settings folder (run `reset` as your own user with the command `init` printed for you, then delete `~/.config/perfoads-mcp`) so no sign-in is left where the AI can read it.

## Any OS (Windows too): separate user + SSH forced command

An SSH key that can only ever run `serve` as the service user. Useful on Windows, where there is no `sudo` rule.

1. **Service user.** A local standard (not Administrator) account, e.g. `perfoadsmcp`, with a strong password.
2. **SSH server.** macOS: System Settings > General > Sharing > Remote Login (allow only `perfoadsmcp`). Linux: `openssh-server`. Windows: Settings > System > Optional features > OpenSSH Server, then start the `sshd` service.
3. **Node.js and the server, admin-owned.** Install Node.js for all users. Install the server into a folder only Administrators/root can write: Windows `npm install --prefix C:\ProgramData\perfoads-mcp perfoads-mcp@<version>` from an Administrator prompt, then `icacls C:\ProgramData\perfoads-mcp /inheritance:r /grant:r Administrators:(OI)(CI)F SYSTEM:(OI)(CI)F Users:(OI)(CI)RX`.
4. **Sign in as the service user**, in a session you open with its password (Windows: `runas /user:perfoadsmcp cmd`; macOS/Linux: `su - perfoadsmcp` or the sudo command above): `PERFOADS_MCP_KEY_BACKEND=file node <path to bin> init` (Windows: `set PERFOADS_MCP_KEY_BACKEND=file` first), then write `config.json` with `{"approval_mode":"code_only","open_browser":false}` and your `policy.yaml` in its settings folder.
5. **A key for the AI app**, on your user: `ssh-keygen -t ed25519 -N "" -f ~/.ssh/perfoads_mcp_serve`. In the service user's `~/.ssh/authorized_keys` (Windows: `C:\Users\perfoadsmcp\.ssh\authorized_keys`, owned by that user), one line:

   ```
   restrict,command="<path to node> <path to bin> serve" ssh-ed25519 AAAA... perfoads-mcp-serve
   ```

   `restrict` turns off terminals, forwarding and agent access; `command=` replaces whatever the client asks to run. On Windows put quotes around paths with spaces inside the command (`command="\"C:\Program Files\nodejs\node.exe\" C:\ProgramData\perfoads-mcp\node_modules\perfoads-mcp\bin\perfoads-mcp.js serve"`).

6. **AI app config:** command `ssh`, args `["-i", "<home>/.ssh/perfoads_mcp_serve", "-o", "BatchMode=yes", "-T", "perfoadsmcp@localhost"]`.
7. **Approving:** in a session as the service user (step 4) opened from a place the AI can't change ([Where you do the human steps](#where-you-do-the-human-steps)), run `approvals open <change_id>`.

The AI can use the key, but only to start the server, exactly as the AI app does. Don't give the service user a key without `command=`, and don't keep its password in a file or password manager the AI can read.

## Linux: container

A container is only a boundary if **your user can't run the container engine without a password**: membership of the `docker` group equals root, and then the AI can `docker exec` into the container. Use a sudo rule for the one `docker run` command (as above), or rootless Podman under the service user started via the sudo rule.

Image (`Dockerfile`):

```dockerfile
FROM node:22-slim
RUN npm install -g perfoads-mcp@<version> && mkdir /data && chown node:node /data
USER node
ENV PERFOADS_MCP_HOME=/data PERFOADS_MCP_KEY_BACKEND=file
VOLUME /data
ENTRYPOINT ["perfoads-mcp"]
CMD ["serve"]
```

```sh
sudo docker build -t perfoads-mcp .
sudo docker run -it --rm --network host -v perfoads-mcp-data:/data perfoads-mcp init
sudo docker run -it --rm -v perfoads-mcp-data:/data --entrypoint sh perfoads-mcp \
  -c 'umask 077; echo "{\"approval_mode\":\"code_only\",\"open_browser\":false}" > /data/config.json'
```

`--network host` lets your browser reach the sign-in answer and the approval page, which listen on `127.0.0.1` inside the container. Sudo rule (one line): `yourname ALL=(root) NOPASSWD: /usr/bin/docker run -i --rm --network host -v perfoads-mcp-data\:/data perfoads-mcp`. AI app config: command `sudo`, args `["-n", "/usr/bin/docker", "run", "-i", "--rm", "--network", "host", "-v", "perfoads-mcp-data:/data", "perfoads-mcp"]`.

Approving: `sudo docker run -it --rm --network host -v perfoads-mcp-data:/data perfoads-mcp approvals open <change_id>`. Edit the policy through a container the same way (`--entrypoint sh`).

## Optional plugin

A plugin named by `pro_plugin` in the service user's `config.json` runs as the service user, so it gets the same treatment as the server itself:

- Install it **root-owned** (like the server in step 2) or owned by the service user, never in a folder of your own user: not in your home folder, not a checkout you work in. The server refuses a plugin when its files, its folder, anything it links to, or any folder above them can be changed by anyone but the service user or root, and `doctor` (run as the service user) says why.
- Its dependencies go in with it (for example a root-owned copy with `node_modules`); a link back into a checkout your user owns is refused.
- Windows (service user): put it inside the service user's settings folder; anywhere else is refused.
- `config.json` itself stays writable only by the service user, as in the rules above.

## What the hardened setup does not cover

- **A browser-control tool in your desktop session** can read an approval page you have open, code included. With `code_only` and `open_browser: false` the code then still has to be typed by you into the service user's terminal (`approvals open` asks for it there; with `open_browser: false` the AI app never shows a form for it), but don't run browser-control or computer-use tools while you approve. `doctor` warns when it finds them in your AI app's config.
- **Hooks that answer MCP forms automatically** (Claude Code hooks can): a hook that types a code it read somewhere would approve. Don't add such hooks; `doctor` warns about the ones it can see.
- **An AI agent with a shell on your user, when you do the human steps in that same user's terminal**: it can fake `sudo` (and capture your password), fake `approvals open`, or change the `sudoedit` copy. Use one of the [sessions above](#where-you-do-the-human-steps).
- **Root / Administrator access**, a compromised OS, or malware running as the service user.
- **Your terminal**: a code typed into a terminal the AI can read (shared tmux session, screen recording) is not secret.
- Changes the policy marks `auto` (pausing a campaign, lowering a budget) still apply without a person, by your own choice.

See [THREAT-MODEL.md](THREAT-MODEL.md) for the full list.
