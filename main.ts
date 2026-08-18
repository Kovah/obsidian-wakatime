import {
	App,
	EditorPosition,
	FileView,
	MarkdownView,
	Notice,
	Plugin,
	PluginSettingTab,
	requestUrl,
	Setting,
	TFile
} from 'obsidian';

// Categories accepted by the Wakatime heartbeats API. Other values are rejected with a 400 error.
const WAKATIME_CATEGORIES = [
	'coding',
	'building',
	'indexing',
	'debugging',
	'browsing',
	'running tests',
	'writing tests',
	'manual testing',
	'writing docs',
	'communicating',
	'code reviewing',
	'notes',
	'researching',
	'learning',
	'designing',
	'ai coding'
];

interface ObsidianWakatimeSettings {
	enabled: boolean;
	apiKey: string | null;
	apiUrl: string | null;
	defaultProject: string | null;
	ignoreList: string[];
	projectAssociations: string[];
	writeCategory: string;
	idleCategory: string;
	debugModeEnabled: boolean;
}

const DEFAULT_SETTINGS: ObsidianWakatimeSettings = {
	enabled: false,
	apiKey: null,
	apiUrl: null,
	defaultProject: null,
	ignoreList: [],
	projectAssociations: [],
	writeCategory: 'writing docs',
	idleCategory: 'notes',
	debugModeEnabled: false
};

export default class ObsidianWakatime extends Plugin {
	settings: ObsidianWakatimeSettings;
	statusBar: HTMLElement;
	lastFile: string;
	lastHeartbeat = 0;
	lastHeartbeatWasWrite = false;
	maxHeartbeatInterval = 120_000; // send a heartbeat max every 2 min per file
	lastRequestWasError = false;

	async onload() {
		await this.migratePluginData();
		await this.loadSettings();

		if (this.settings.debugModeEnabled) console.info('Loading wakatime-kvh');

		this.statusBar = this.addStatusBarItem();
		this.updateStatusBarText();

		this.addCommand({
			id: 'wakatime-plugin-toggle-enabled',
			name: 'Enable/Disable the plugin',
			callback: async () => {
				this.settings.enabled = !this.settings.enabled;
				await this.saveSettings();
				new Notice('Wakatime Plugin is now ' + (this.settings.enabled ? 'enabled' : 'disabled'));
				this.updateStatusBarText();
			}
		});

		this.addSettingTab(new WakatimeSettingTab(this.app, this));

		this.setupEventListeners();
	}

	onunload() {
		// nothing to do here
	}

	async migratePluginData() {
		if (typeof this.settings?.debugModeEnabled !== 'undefined') {
			this.settings.debugModeEnabled = false;
			await this.saveSettings();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		// drop empty ignore list entries; an empty string matches every file path
		this.settings.ignoreList = this.settings.ignoreList.filter(line => line.trim().length > 0);
	}

	async saveSettings() {
		await this.saveData(this.settings);
		if (this.settings.debugModeEnabled) console.info('Saved new settings', {'settings': this.settings});
	}

	private setupEventListeners(): void {
		// Settings and note editors can live in pop-out windows, each with their own
		// document. activeDocument only points to the window focused at load time, so
		// register on the main window plus every existing and future pop-out window.
		const documents = new Set<Document>([document]);
		this.app.workspace.iterateAllLeaves(leaf => documents.add(leaf.view.containerEl.ownerDocument));
		documents.forEach(doc => this.registerDocumentEvents(doc));

		this.registerEvent(this.app.workspace.on('window-open', (workspaceWindow) => {
			this.registerDocumentEvents(workspaceWindow.doc);
		}));
	}

	private registerDocumentEvents(doc: Document): void {
		this.registerDomEvent(doc, 'click', () => {
			this.onEvent();
		});
		this.registerDomEvent(doc, 'keydown', () => {
			this.onEvent();
		});
		this.registerDomEvent(doc, 'scroll', () => {
			this.onEvent();
		}, {capture: true});
		this.registerDomEvent(doc, 'touchmove', () => {
			this.onEvent();
		});
	}

	private onEvent() {
		const debug = this.settings.debugModeEnabled;
		if (debug) console.info('Received event');
		if (!this.settings.enabled) {
			if (debug) console.info('Skipping event: plugin is disabled');
			return;
		}

		// check if a real file is opened
		const view = this.app.workspace.getActiveViewOfType(FileView);
		if (!view) {
			if (debug) console.info('Skipping event: no active file view');
			return;
		}

		// check if a file is actively viewed
		const activeFile = this.app.workspace.getActiveFile();
		if (!activeFile) {
			if (debug) console.info('Skipping event: no active file');
			return;
		}

		// check if the current file matches a path from the ignore list
		if (this.settings.ignoreList.some(ignored => ignored.contains(activeFile.path) || activeFile.path.contains(ignored))) {
			if (debug) console.info('Skipping event: file is on the ignore list', {'file': activeFile.path});
			return;
		}

		const time: number = Date.now();
		let cursor: EditorPosition | null = null;
		// a markdown view in editing mode counts as writing, reading mode and other views as idle
		let isWrite = false;
		if (view instanceof MarkdownView) {
			cursor = view.editor.getCursor();
			isWrite = view.getMode() === 'source';
		}

		// send a heartbeat if enough time passed, the file changed, or the editing
		// mode changed since the last heartbeat
		if (this.enoughTimePassed(time) || this.lastFile !== activeFile.path || isWrite !== this.lastHeartbeatWasWrite) {
			this.sendHeartbeat(activeFile, time, cursor?.line, cursor?.ch, isWrite);
			this.lastFile = activeFile.path;
			this.lastHeartbeat = time;
			this.lastHeartbeatWasWrite = isWrite;
		} else if (debug) {
			console.info('Skipping heartbeat: waiting for the max heartbeat interval to pass', {
				'file': activeFile.path,
				'nextHeartbeatInMs': this.lastHeartbeat + this.maxHeartbeatInterval - time
			});
		}
	}

	private enoughTimePassed(time: number): boolean {
		return this.lastHeartbeat + this.maxHeartbeatInterval < time;
	}

	private sendHeartbeat(file: TFile, time: number, line: number | undefined, cursorPosition: number | undefined, isWrite: boolean) {
		if (!this.settings.enabled) return;

		const apiUrl = `${this.settings.apiUrl ? this.settings.apiUrl : 'https://api.wakatime.com'}/api/v1/users/current/heartbeats`;
		// @ts-ignore
		const auth = `Basic ${btoa(this.settings.apiKey)}`;
		const filePath = `/${this.app.vault.getName()}/${file.path}`;
		const lang = this.getLanguageForFile(file);
		const project = this.getProjectForFile(file);

		if (this.settings.debugModeEnabled) console.info('Sending heartbeat', {
			'url': apiUrl,
			'auth': auth,
			'filePath': filePath,
			'cursorPosition': cursorPosition,
			'isWrite': isWrite,
			'lang': lang,
			'project': project,
			category: isWrite ? this.settings.writeCategory : this.settings.idleCategory
		});

		requestUrl({
			url: apiUrl,
			method: 'POST',
			headers: {
				'Accept': 'application/json',
				'Content-Type': 'application/json',
				'Authorization': auth
			},
			body: JSON.stringify({
				time: time / 1000,
				entity: filePath,
				type: 'file',
				project: project,
				language: lang,
				is_write: isWrite,
				cursorpos: cursorPosition !== undefined ? cursorPosition + 1 : undefined,
				lineno: line !== undefined ? line + 1 : undefined,
				editor: 'Obsidian',
				category: isWrite ? this.settings.writeCategory : this.settings.idleCategory
			})
		})
			.then(response => {
				if (this.settings.debugModeEnabled) console.info('Response from sending heartbeat', response);
				if (response.status >= 300) {
					this.updateStatusBarText('Network Error');
					if (!this.lastRequestWasError) {
						new Notice('Could not send data to Wakatime. Please check the logs.');
					}
					this.lastRequestWasError = true;
					throw new Error('Network response was not ok: ' + response.text);
				}
				return response.json;
			})
			.then(() => {
				this.updateStatusBarText();
				this.lastRequestWasError = false;
			})
			.catch(error => {
				if (this.settings.debugModeEnabled) console.info('Error while sending heartbeat', error);
				this.updateStatusBarText('Unexpected Error');
				if (!this.lastRequestWasError) {
					new Notice('Could not send data to Wakatime. Please check the logs.');
				}
				console.error('There was a problem with the fetch operation:', error);
				this.lastRequestWasError = true;
			});
	}

	private getProjectForFile(file: TFile): string {
		for (const association of this.settings.projectAssociations) {
			const [path, project] = association.split('@');
			if (!path || !project || association.split('@').length !== 2) continue;
			if (file.path.includes(path)) {
				return project;
			}
		}
		return this.settings.defaultProject ? this.settings.defaultProject : this.app.vault.getName();
	}

	private getLanguageForFile(file: TFile): string | null {
		const extension = file.extension;
		switch (extension) {
			case 'md':
				return 'Markdown';
			default:
				return null;
		}
	}

	public updateStatusBarText(text: string | null = null) {
		const enabledText = this.settings.enabled ? 'Enabled' : 'Disabled';
		this.statusBar.setText(`⏱️ ` + (text !== null ? text : enabledText));
	}
}

class WakatimeSettingTab extends PluginSettingTab {
	plugin: ObsidianWakatime;

	constructor(app: App, plugin: ObsidianWakatime) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;
		containerEl.empty();

		new Setting(containerEl).setName('Basic setup').setHeading();

		new Setting(containerEl)
			.setName('Enable the plugin')
			.setDesc('Once you configured the plugin to your needs, enable it here.')
			.setClass('wakatimekvh-input')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.enabled)
				.onChange(async (value) => {
					if (value && !this.plugin.settings.apiKey) {
						new Notice('Please set a valid API key first.');
						toggle.setValue(false);
						return;
					}
					this.plugin.settings.enabled = value;
					await this.plugin.saveSettings();
					this.plugin.updateStatusBarText();
				}));

		new Setting(containerEl)
			.setName('API key')
			.setDesc('Enter your Wakatime / Wakapi API key.')
			.setClass('wakatimekvh-input')
			.addText(text => text
				.setPlaceholder('81cee032-f24...')
				.setValue(this.plugin.settings.apiKey ? this.plugin.settings.apiKey : '')
				.onChange(async (value) => {
					this.plugin.settings.apiKey = value !== '' ? value : null;
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl).setName('Optional configuration').setHeading();

		new Setting(containerEl)
			.setName('Wakapi URL')
			.setDesc('Leave it blank if you want to use Wakatime. For Wakapi, add your Wakapi domain without any path.')
			.setClass('wakatimekvh-input')
			.addText(text => text
				.setPlaceholder('https://wakapi.my-apps.com')
				.setValue(this.plugin.settings.apiUrl ? this.plugin.settings.apiUrl : '')
				.onChange(async (value) => {
					this.plugin.settings.apiUrl = value !== '' ? value : null;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Default project')
			.setDesc('Set a specific project for your Vault. If empty, the Vault name will be used')
			.setClass('wakatimekvh-input')
			.addText(text => text
				.setPlaceholder('My Project')
				.setValue(this.plugin.settings.defaultProject ? this.plugin.settings.defaultProject : '')
				.onChange(async (value) => {
					this.plugin.settings.defaultProject = value !== '' ? value : null;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Ignore list')
			.setDesc('Specify paths that should be ignored and not tracked. One entry per line.\nPaths may either be absolute or relative from the root of your Vault.')
			.setClass('wakatimekvh-textarea')
			.addTextArea(text => text
				.setPlaceholder('/Users/kevin/Obsidian Notes/some/ignored/folder\nor\nsome/ignored/folder/specific note.md')
				.setValue(this.plugin.settings.ignoreList.join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.ignoreList = value.split('\n').filter(line => line.trim().length > 0);
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Project association')
			.setDesc('Define which paths or files should be assigned a specific project. Use the [path]@[project name] syntax.\nPaths may either be absolute or relative from the root of your Vault.')
			.setClass('wakatimekvh-textarea')
			.addTextArea(text => text
				.setPlaceholder('/Users/kevin/Obsidian Notes/path/to/project@myProject\nor\npath/to/project/notes.md@another Project')
				.setValue(this.plugin.settings.projectAssociations.join('\n'))
				.onChange(async (value) => {
					this.plugin.settings.projectAssociations = value.length > 0 ? value.split('\n') : [];
					await this.plugin.saveSettings();
				})
			);

		const categoryOptions = Object.fromEntries(WAKATIME_CATEGORIES.map(category => [category, category]));

		new Setting(containerEl)
			.setName('Category while writing')
			.setDesc('Category reported to Wakatime while you are actively writing.')
			.setClass('wakatimekvh-input')
			.addDropdown(dropdown => dropdown
				.addOptions(categoryOptions)
				.setValue(this.plugin.settings.writeCategory)
				.onChange(async (value) => {
					this.plugin.settings.writeCategory = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName('Category while idle')
			.setDesc('Category reported to Wakatime while you are viewing or navigating notes.')
			.setClass('wakatimekvh-input')
			.addDropdown(dropdown => dropdown
				.addOptions(categoryOptions)
				.setValue(this.plugin.settings.idleCategory)
				.onChange(async (value) => {
					this.plugin.settings.idleCategory = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl).setName('Advanced settings').setHeading();

		new Setting(containerEl)
			.setName('Debug mode')
			.setDesc('Enable the debug mode in case you are having issues. The plugin will then log more details about what it is doing to the Console.')
			.setClass('wakatimekvh-input')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.debugModeEnabled)
				.onChange(async (value) => {
					this.plugin.settings.debugModeEnabled = value;
					await this.plugin.saveSettings();
					this.plugin.updateStatusBarText();
				}));

		containerEl.createEl('br');
		containerEl.createEl('hr');
		containerEl.createEl('small').innerHTML = '❤️ Support my work via <a href="https://patreon.com/Kovah" target="_blank">Patreon</a>, <a href="https://github.com/Kovah" target="_blank">GitHub Sponsors</a> or <a href="https://liberapay.com/kovah" target="_blank">Liberapay</a>';
	}
}
