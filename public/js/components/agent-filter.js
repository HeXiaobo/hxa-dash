// Agent Filter/Selector Component — Global (#87)
// Single global agent filter applied to all pages
const AgentFilter = {
  STORAGE_KEY: 'hxa-dash-filter-global',

  // Current filter state: null = show all, Set = show subset
  filter: null,

  // All known agents
  allAgents: [],

  init() {
    // Load persisted filter
    const saved = localStorage.getItem(this.STORAGE_KEY);
    if (saved) {
      try {
        const names = JSON.parse(saved);
        if (Array.isArray(names) && names.length > 0) {
          this.filter = new Set(names);
        }
      } catch {}
    }

    // Migrate from old per-context storage keys
    for (const old of ['hxa-dash-filter-overview', 'hxa-dash-filter-collab', 'hxa-dash-filter-tasks', 'hxa-dash-filter-timeline']) {
      if (!this.filter && localStorage.getItem(old)) {
        try {
          const names = JSON.parse(localStorage.getItem(old));
          if (Array.isArray(names) && names.length > 0) this.filter = new Set(names);
        } catch {}
      }
      localStorage.removeItem(old);
    }

    this._setupModal();
    this._setupGlobalButton();
  },

  // Update the agent list (called when team data arrives)
  setAgents(agents) {
    this.allAgents = agents.map(a => ({
      name: a.name,
      online: !!a.online,
      role: a.role || ''
    }));
    this._updateGlobalLabel();
  },

  // Get the global filter (null = all)
  getFilter(_context) {
    return this.filter;
  },

  // Check if an agent passes the filter
  passes(_context, agentName) {
    if (!this.filter) return true;
    return this.filter.has(agentName);
  },

  // Filter a list of items by agent name
  filterItems(_context, items, agentKey = 'assignee') {
    if (!this.filter) return items;
    return items.filter(item => {
      const name = item[agentKey];
      return !name || this.filter.has(name);
    });
  },

  // Save filter
  _save() {
    if (this.filter) {
      localStorage.setItem(this.STORAGE_KEY, JSON.stringify([...this.filter]));
    } else {
      localStorage.removeItem(this.STORAGE_KEY);
    }
  },

  // Update count display (no-op for removed per-page elements, kept for compat)
  updateCountDisplay(_context) {
    // Global label is updated via _updateGlobalLabel
  },

  // Update global header label
  _updateGlobalLabel() {
    const label = document.getElementById('global-agent-label');
    const clearBtn = document.getElementById('global-clear-filter');
    if (label) {
      if (this.filter) {
        label.textContent = `${this.filter.size} / ${this.allAgents.length} Agent`;
        label.classList.add('filtered');
      } else {
        label.textContent = `全部 ${this.allAgents.length} Agent`;
        label.classList.remove('filtered');
      }
    }
    if (clearBtn) {
      clearBtn.style.display = this.filter ? '' : 'none';
    }
  },

  // Setup global header button
  _setupGlobalButton() {
    const btn = document.getElementById('global-select-agents');
    if (btn) btn.addEventListener('click', () => this.openSelector());

    const clearBtn = document.getElementById('global-clear-filter');
    if (clearBtn) clearBtn.addEventListener('click', () => {
      this.filter = null;
      this._save();
      this._updateGlobalLabel();
      if (typeof App !== 'undefined') App.onGlobalFilterChange();
    });
  },

  // Open agent selector modal
  _tempSelection: null,

  openSelector() {
    this._tempSelection = this.filter ? new Set(this.filter) : new Set(this.allAgents.map(a => a.name));
    this._renderModalList();
    document.getElementById('agent-selector-modal').classList.remove('hidden');
  },

  _setupModal() {
    const modal = document.getElementById('agent-selector-modal');
    if (!modal) return;

    modal.querySelector('.modal-overlay').addEventListener('click', () => this._closeModal());
    modal.querySelector('.modal-close').addEventListener('click', () => this._closeModal());
    document.getElementById('modal-cancel').addEventListener('click', () => this._closeModal());

    document.getElementById('modal-select-all').addEventListener('click', () => {
      this._tempSelection = new Set(this.allAgents.map(a => a.name));
      this._renderModalList();
    });

    document.getElementById('modal-clear-all').addEventListener('click', () => {
      this._tempSelection = new Set();
      this._renderModalList();
    });

    document.getElementById('modal-apply').addEventListener('click', () => {
      if (this._tempSelection.size === 0 || this._tempSelection.size === this.allAgents.length) {
        this.filter = null;
      } else {
        this.filter = new Set(this._tempSelection);
      }
      this._save();
      this._updateGlobalLabel();
      this._closeModal();

      if (typeof App !== 'undefined') App.onGlobalFilterChange();
    });
  },

  _renderModalList() {
    const container = document.getElementById('modal-agent-list');
    if (!container) return;

    const sorted = [...this.allAgents].sort((a, b) => {
      if (a.online !== b.online) return b.online - a.online;
      return a.name.localeCompare(b.name);
    });

    container.innerHTML = sorted.map(a => {
      const checked = this._tempSelection.has(a.name) ? 'checked' : '';
      return `
        <label class="check-item">
          <input type="checkbox" value="${esc(a.name)}" ${checked}>
          <span class="online-dot ${a.online ? 'online' : 'offline'}"></span>
          <span class="check-name">${esc(a.name)}</span>
          <span class="check-role">${esc(a.role)}</span>
        </label>
      `;
    }).join('');

    container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', () => {
        if (cb.checked) {
          this._tempSelection.add(cb.value);
        } else {
          this._tempSelection.delete(cb.value);
        }
      });
    });
  },

  _closeModal() {
    document.getElementById('agent-selector-modal').classList.add('hidden');
    this._tempSelection = null;
  },

  // Compat stubs for removed collab sidebar
  initCollabButtons() {},
  _renderCollabSidebar() {}
};
