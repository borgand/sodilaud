// SPDX-License-Identifier: GPL-3.0-or-later

// Agent access, shared by the main window and Quick Notes: the menu section,
// the MCP Configuration modal and the "MCP listening" indicator. Rust owns the
// state and sends mcp-state-changed to both windows whenever it changes.

import { trapModalFocus } from "./modal-focus.js";

export const STATE_EVENT = "mcp-state-changed";

const READ_FUNCTIONS = [
  ["list_folders", "List folders", "Folder names, IDs, and note counts."],
  ["list_notes", "List notes", "Note metadata and short previews."],
  ["search_notes", "Search notes", "Search titles and note content."],
  ["get_note", "Get note", "Read content and its current revision."],
  ["list_trash", "List trash", "Deleted-note titles, original folders, and deletion times."],
  ["list_documents", "List documents", "Open files and commented notes, with pending comment counts."],
  ["read_document", "Read document", "Live text of an open file or a note; marks it co-edited."],
  ["get_pending_comments", "Get pending comments", "Take your comments that wait for an agent, waiting up to 30 minutes."]
];
const WRITE_FUNCTIONS = [
  ["create_note", "Create note", "Add a note to the current collection."],
  ["create_folder", "Create folder", "Add a folder to the current collection."],
  ["append_to_note", "Append to note", "Add text to an existing note with revision checking."],
  ["rename_note", "Rename note", "Set and lock a note title with revision checking."],
  ["move_note", "Move note", "Move a note to a folder or the top level."],
  ["rename_folder", "Rename folder", "Rename a folder with revision checking."],
  ["delete_note", "Delete note", "Move a note into recoverable trash."],
  ["delete_folder", "Delete empty folder", "Delete a folder only when it has no notes."],
  ["push_quick_note", "Push quick note", "Add a note to From agents and show the panel without taking focus."],
  ["open_document", "Open document", "Open a Markdown or text file in the main window. Returns no content."],
  ["apply_edit", "Apply edit", "Merge edits into a co-edited file or note around your typing."],
  ["add_comment", "Add comment", "Leave a question on a passage for you to answer."],
  ["resolve_comment", "Resolve comment", "Mark a comment addressed with a one-line note."]
];
export const MCP_READ_TOOLS = READ_FUNCTIONS.map(([tool]) => tool);
export const MCP_WRITE_TOOLS = WRITE_FUNCTIONS.map(([tool]) => tool);

const defaultPermissions = () => Object.fromEntries([...MCP_READ_TOOLS.map(tool => [tool, true]), ...MCP_WRITE_TOOLS.map(tool => [tool, false])]);
const permissionsFrom = tools => Object.fromEntries([...MCP_READ_TOOLS, ...MCP_WRITE_TOOLS].map(tool => [tool, tools.includes(tool)]));

const MENU_SECTION = `
  <div class="dropdown-section-title">Agent access</div>
  <div class="view-setting-row">
    <span class="view-setting-label">Agent access</span>
    <button class="view-setting-toggle" id="agent-access-toggle-btn" type="button" aria-label="Toggle agent access" aria-pressed="false">Off</button>
  </div>
  <button class="dropdown-item" id="agent-access-config-btn" aria-haspopup="dialog">MCP Configuration…</button>`;

const permissionGroup = (legend, kind, functions, checked) => `
  <fieldset class="mcp-permission-group">
    <legend>${legend}</legend>
    <label class="mcp-permission-all"><input type="checkbox" id="mcp-select-all-${kind}" data-mcp-select-all="${kind}" /> Select all ${kind} functions</label>
    ${functions.map(([tool, name, description]) => `
    <label class="mcp-permission-option" for="mcp-permission-${tool}">
      <input type="checkbox" id="mcp-permission-${tool}" data-mcp-tool="${tool}"${checked ? " checked" : ""} />
      <span><strong>${name}</strong><code>${tool}</code><small>${description}</small></span>
    </label>`).join("")}
  </fieldset>`;

const MODAL = `
  <div class="help-modal mcp-config-modal" id="mcp-config-modal" role="dialog" aria-modal="true" aria-labelledby="mcp-config-modal-heading">
    <div class="help-modal-header">
      <div class="mcp-config-modal-title">
        <svg class="mcp-config-modal-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path stroke-linecap="round" stroke-linejoin="round" d="M12 3v6m0 6v6M3 12h6m6 0h6" />
        </svg>
        <h3 id="mcp-config-modal-heading">MCP Configuration</h3>
      </div>
      <button class="close-help-btn" id="close-mcp-config-btn" title="Close (Escape)" aria-label="Close MCP configuration">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16">
          <path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
        </svg>
      </button>
    </div>

    <div class="help-modal-body mcp-config-modal-body">
      <p class="mcp-config-description">Use these values in an MCP client that supports local stdio servers. Sodilaud must remain open with agent access enabled. Choose which functions agents can use below.</p>

      <div class="mcp-config-fields" aria-label="MCP connection values">
        <div class="mcp-config-field">
          <span class="mcp-config-label">Transport</span>
          <code class="mcp-config-value">stdio</code>
        </div>
        <div class="mcp-config-field">
          <label class="mcp-config-label" for="mcp-config-command">Command</label>
          <div class="mcp-config-value-row">
            <input class="mcp-config-input" id="mcp-config-command" type="text" readonly spellcheck="false" aria-label="Sodilaud executable path" />
            <button class="mcp-config-copy-btn" id="copy-mcp-command-btn" type="button">Copy command</button>
          </div>
        </div>
        <div class="mcp-config-field">
          <label class="mcp-config-label" for="mcp-config-args">Argument</label>
          <div class="mcp-config-value-row">
            <input class="mcp-config-input" id="mcp-config-args" type="text" readonly spellcheck="false" aria-label="MCP command argument" />
            <button class="mcp-config-copy-btn" id="copy-mcp-args-btn" type="button">Copy argument</button>
          </div>
        </div>
      </div>

      <section class="mcp-permissions" aria-labelledby="mcp-permissions-heading">
        <h4 id="mcp-permissions-heading">Function permissions</h4>
        <p class="mcp-permissions-description">Changes apply immediately in both windows. Sodilaud remembers these choices, and whether access is on, across restarts. A new function starts enabled if it reads and off if it writes.</p>
        <p class="mcp-permissions-summary" id="mcp-permissions-summary" role="status">Off</p>
        <div class="mcp-permission-groups">
          ${permissionGroup("Read", "read", READ_FUNCTIONS, true)}
          ${permissionGroup("Write", "write", WRITE_FUNCTIONS, false)}
        </div>
        <p id="mcp-permission-status" class="mcp-permission-status" role="status" aria-live="polite"></p>
      </section>

      <section class="mcp-permissions coedit-integration" aria-labelledby="coedit-integration-heading">
        <h4 id="coedit-integration-heading">Claude Code integration</h4>
        <p class="mcp-permissions-description">Adds the <code>/sodilaud</code> command and the <code>sodilaud</code> skill to Claude Code, and a hook that sends Claude Code's own edits of files you co-edit here through Sodilaud. Name this server <code>sodilaud</code> in Claude Code. Nothing changes until you confirm.</p>
        <p class="mcp-permissions-summary" id="coedit-integration-summary" role="status">Checking…</p>
        <ul class="coedit-integration-changes" id="coedit-integration-changes" hidden></ul>
        <div class="coedit-integration-actions">
          <button class="mcp-config-copy-btn" id="coedit-integration-btn" type="button">Install Claude Code integration…</button>
          <button class="mcp-config-copy-btn" id="coedit-integration-confirm-btn" type="button" hidden>Install</button>
          <button class="mcp-config-copy-btn" id="coedit-integration-cancel-btn" type="button" hidden>Cancel</button>
          <button class="mcp-config-copy-btn" id="coedit-integration-remove-btn" type="button" hidden>Remove</button>
        </div>
      </section>

      <div class="mcp-config-example">
        <div class="mcp-config-example-header">
          <div>
            <h4>Generic configuration example</h4>
            <p>Property names can vary by client, but this shows the connection values and their intended structure.</p>
          </div>
          <button class="mcp-config-copy-btn" id="copy-mcp-example-btn" type="button">Copy example</button>
        </div>
        <pre class="mcp-config-example-code" id="mcp-config-example-code" aria-label="Generic MCP configuration example"></pre>
      </div>

      <p class="mcp-config-security-note">Connected agents can read the current collection, including what you typed moments ago, and may send note contents to their model provider.</p>
    </div>
  </div>`;

// `menuSection` receives the toggle and the MCP Configuration button, and the
// indicator goes just before `statusAnchor`. `closeMenu` closes the window's
// menu and returns focus to its button. `beforeEnable` runs before access
// starts, so agents never read text older than the window's.
export function createAgentAccess({ document, invoke, notify, menuSection, statusAnchor, closeMenu, beforeEnable = async () => {} }) {
  menuSection.innerHTML = MENU_SECTION;
  const status = document.createElement("span");
  status.id = "mcp-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.title = "MCP agent access is enabled and listening for connections";
  status.hidden = true;
  status.textContent = "MCP listening";
  statusAnchor.before(status);
  const backdrop = document.createElement("div");
  backdrop.className = "help-modal-backdrop";
  backdrop.id = "mcp-config-modal-backdrop";
  backdrop.style.display = "none";
  backdrop.setAttribute("aria-hidden", "true");
  backdrop.innerHTML = MODAL;
  document.body.append(backdrop);

  const $ = id => document.getElementById(id);
  const toggleBtn = $("agent-access-toggle-btn");
  const configBtn = $("agent-access-config-btn");
  const modal = $("mcp-config-modal");
  const closeBtn = $("close-mcp-config-btn");
  const commandInput = $("mcp-config-command");
  const argsInput = $("mcp-config-args");
  const copyCommandBtn = $("copy-mcp-command-btn");
  const copyArgsBtn = $("copy-mcp-args-btn");
  const copyExampleBtn = $("copy-mcp-example-btn");
  const exampleCode = $("mcp-config-example-code");
  const summary = $("mcp-permissions-summary");
  const permissionStatus = $("mcp-permission-status");
  const permissionInputs = [...modal.querySelectorAll("[data-mcp-tool]")];
  const selectAllInputs = [...modal.querySelectorAll("[data-mcp-select-all]")];
  const integrationSummary = $("coedit-integration-summary");
  const integrationChanges = $("coedit-integration-changes");
  const integrationBtn = $("coedit-integration-btn");
  const integrationConfirmBtn = $("coedit-integration-confirm-btn");
  const integrationCancelBtn = $("coedit-integration-cancel-btn");
  const integrationRemoveBtn = $("coedit-integration-remove-btn");

  let enabled = false;
  let permissions = defaultPermissions();
  let startError = null;
  let saving = false;
  let connectionInfo = null;
  let modalOpen = false;
  let previousFocus = null;

  const offMessage = () => startError
    ? `Agent access was on when Sodilaud quit but could not start again: ${startError}`
    : "Agent access is off. Enable it from the menu to change function permissions.";

  function update() {
    status.hidden = !enabled;
    const readCount = MCP_READ_TOOLS.filter(tool => permissions[tool]).length;
    const writeCount = MCP_WRITE_TOOLS.filter(tool => permissions[tool]).length;
    summary.textContent = enabled ? `${readCount} read · ${writeCount} write functions enabled` : "Off";
    status.title = `MCP listening: ${summary.textContent.toLowerCase()}`;
    toggleBtn.textContent = enabled ? "On" : "Off";
    toggleBtn.setAttribute("aria-pressed", String(enabled));
    for (const input of permissionInputs) {
      input.checked = permissions[input.dataset.mcpTool];
      input.disabled = !enabled || saving;
    }
    for (const input of selectAllInputs) {
      const tools = input.dataset.mcpSelectAll === "read" ? MCP_READ_TOOLS : MCP_WRITE_TOOLS;
      const count = tools.filter(tool => permissions[tool]).length;
      input.checked = count === tools.length;
      input.indeterminate = count > 0 && count < tools.length;
      input.disabled = !enabled || saving;
    }
  }

  async function changePermissions(next) {
    if (!enabled || saving) { update(); return; }
    const previous = permissions;
    saving = true;
    toggleBtn.disabled = true;
    // Revoke immediately so queued writes cannot begin during the native update.
    // New grants take effect only after the backend confirms them.
    permissions = Object.fromEntries(Object.keys(previous).map(tool => [tool, previous[tool] && next[tool]]));
    update();
    permissionStatus.textContent = "Saving permissions…";
    try {
      await invoke("set_mcp_permissions", { tools: Object.keys(next).filter(tool => next[tool]) });
      permissions = next;
      permissionStatus.textContent = "Permissions saved";
    } catch (error) {
      permissions = previous;
      permissionStatus.textContent = `Could not save permissions: ${error.message || error}`;
    } finally {
      saving = false;
      toggleBtn.disabled = false;
      update();
    }
  }

  async function toggle() {
    if (!document.defaultView?.__TAURI__) {
      notify("Agent access is only available in the desktop app");
      return;
    }
    toggleBtn.disabled = true;
    configBtn.disabled = true;
    startError = null;
    const previousPermissions = permissions;
    const disabling = enabled;
    try {
      if (enabled) {
        if (modalOpen) closeModal();
        permissions = Object.fromEntries(Object.keys(permissions).map(tool => [tool, false]));
        await invoke("stop_mcp_server");
        enabled = false;
        connectionInfo = null;
        update();
        notify("Agent access disabled");
        return;
      }

      await beforeEnable();
      const connection = await invoke("start_mcp_server");
      if (!connection?.command || !Array.isArray(connection?.args) || !connection.args.length) {
        throw new Error("Sodilaud returned incomplete MCP connection details");
      }
      connectionInfo = { command: connection.command, args: connection.args };
      permissions = permissionsFrom(Array.isArray(connection.tools) ? connection.tools : []);
      enabled = true;
      update();
      const writeCount = MCP_WRITE_TOOLS.filter(tool => permissions[tool]).length;
      notify(writeCount
        ? `Agent access enabled with ${writeCount} write ${writeCount === 1 ? "function" : "functions"} allowed`
        : "Agent access enabled - reads only until you allow write functions in MCP Configuration");
    } catch (error) {
      if (disabling) permissions = previousPermissions;
      update();
      console.error("Could not change MCP agent access", error);
      notify(disabling
        ? "Could not disable agent access"
        : `Could not enable agent access: ${error}`);
    } finally {
      toggleBtn.disabled = false;
      configBtn.disabled = false;
    }
  }

  // The state as Rust holds it, after a change made in either window.
  function receive(state) {
    if (!state || typeof state !== "object") return;
    const wasEnabled = enabled;
    enabled = Boolean(state.enabled);
    startError = state.error ?? null;
    permissions = permissionsFrom(enabled && Array.isArray(state.tools) ? state.tools : []);
    if (wasEnabled && !enabled && modalOpen) permissionStatus.textContent = offMessage();
    if (state.integration) renderIntegration(state.integration);
    update();
  }

  // Rust starts access at launch when it was on at quit, before this page loads.
  async function load() {
    try {
      const state = await invoke("get_mcp_state");
      startError = state?.error ?? null;
      if (state?.enabled) {
        enabled = true;
        permissions = permissionsFrom(Array.isArray(state.tools) ? state.tools : []);
      }
    } catch (error) {
      console.error("Could not read the agent access state", error);
    } finally {
      update();
    }
  }

  async function listen(listenFn) {
    if (typeof listenFn !== "function") return;
    await listenFn(STATE_EVENT, ({ payload }) => receive(payload));
  }

  async function openModal() {
    permissionStatus.textContent = enabled ? "" : offMessage();
    update();
    previousFocus = document.activeElement;
    modalOpen = true;
    backdrop.style.display = "flex";
    backdrop.setAttribute("aria-hidden", "false");
    closeBtn.focus({ preventScroll: true });
    runIntegration("coedit_integration_plan");
    const copyButtons = [copyCommandBtn, copyArgsBtn, copyExampleBtn];
    copyButtons.forEach(button => { button.disabled = true; });
    try {
      if (!connectionInfo) connectionInfo = await invoke("get_mcp_connection_info");
      if (!modalOpen) return;
      if (!connectionInfo?.command || !Array.isArray(connectionInfo.args) || !connectionInfo.args.length) {
        throw new Error("Connection details are unavailable");
      }
      commandInput.value = connectionInfo.command;
      argsInput.value = connectionInfo.args.join(" ");
      exampleCode.textContent = JSON.stringify({
        mcpServers: { sodilaud: { command: connectionInfo.command, args: connectionInfo.args } }
      }, null, 2);
      copyButtons.forEach(button => { button.disabled = false; });
    } catch (error) {
      if (modalOpen) permissionStatus.textContent = `Could not load MCP configuration: ${error.message || error}`;
    }
  }

  // The Claude Code integration writes into the owner's home folder, so the
  // button first shows what would change and writes only once confirmed.
  function renderIntegration(plan, { previewing = false, message = null } = {}) {
    const installed = Boolean(plan?.installed);
    const present = Boolean(plan?.present);
    const changes = Array.isArray(plan?.changes) ? plan.changes : [];
    integrationSummary.textContent = message ?? (installed
      ? "Installed."
      : present ? "Installed, but out of date." : "Not installed.");
    integrationChanges.replaceChildren(...(previewing ? changes : []).map(change => {
      const item = document.createElement("li");
      item.textContent = change;
      return item;
    }));
    integrationChanges.hidden = !previewing;
    integrationBtn.hidden = previewing || installed;
    integrationBtn.textContent = present ? "Update Claude Code integration…" : "Install Claude Code integration…";
    integrationConfirmBtn.hidden = !previewing;
    integrationCancelBtn.hidden = !previewing;
    integrationRemoveBtn.hidden = previewing || !present;
  }

  async function runIntegration(command, previewing = false) {
    try {
      renderIntegration(await invoke(command), { previewing });
    } catch (error) {
      renderIntegration(null, { message: `Claude Code integration: ${error.message || error}` });
      integrationBtn.hidden = false;
    }
  }

  function closeModal() {
    modalOpen = false;
    backdrop.style.display = "none";
    backdrop.setAttribute("aria-hidden", "true");
    commandInput.value = "";
    argsInput.value = "";
    exampleCode.textContent = "";
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    previousFocus = null;
  }

  function copyValue(value, label) {
    navigator.clipboard.writeText(value).then(() => {
      notify(`${label} copied`);
    }).catch(error => {
      console.error(`Failed to copy MCP ${label.toLowerCase()}`, error);
      notify(`Could not copy ${label.toLowerCase()}`);
    });
  }

  function attach() {
    toggleBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle();
    });
    configBtn.addEventListener("click", () => {
      closeMenu();
      openModal();
    });
    for (const input of permissionInputs) {
      input.addEventListener("change", () => changePermissions({ ...permissions, [input.dataset.mcpTool]: input.checked }));
    }
    for (const input of selectAllInputs) {
      input.addEventListener("change", () => {
        const tools = input.dataset.mcpSelectAll === "read" ? MCP_READ_TOOLS : MCP_WRITE_TOOLS;
        changePermissions({ ...permissions, ...Object.fromEntries(tools.map(tool => [tool, input.checked])) });
      });
    }
    closeBtn.addEventListener("click", closeModal);
    integrationBtn.addEventListener("click", () => runIntegration("coedit_integration_plan", true));
    integrationConfirmBtn.addEventListener("click", () => runIntegration("coedit_integration_install"));
    integrationCancelBtn.addEventListener("click", () => runIntegration("coedit_integration_plan"));
    integrationRemoveBtn.addEventListener("click", () => runIntegration("coedit_integration_remove"));
    backdrop.addEventListener("click", (event) => {
      if (event.target === backdrop) closeModal();
    });
    copyCommandBtn.addEventListener("click", () => copyValue(commandInput.value, "MCP command"));
    copyArgsBtn.addEventListener("click", () => copyValue(argsInput.value, "MCP argument"));
    copyExampleBtn.addEventListener("click", () => copyValue(exampleCode.textContent, "Configuration example"));
  }

  // Tab stays inside the open modal and Escape closes it. Returns whether the
  // key was handled.
  function handleKeydown(event) {
    if (!modalOpen) return false;
    if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) {
      trapModalFocus(event, modal);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
      return true;
    }
    return false;
  }

  update();
  return { attach, load, listen, receive, openModal, closeModal, handleKeydown, isModalOpen: () => modalOpen };
}
