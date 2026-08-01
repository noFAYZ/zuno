import type { DataSource } from "../datasource/DataSource";
import type { PlayerSession, PlayerState } from "./PlayerController";
import { PlayerController } from "./PlayerController";
import type { PlaybackSettings } from "./playbackSettings";

export type MusicTabId = string;

export interface MusicTab {
  id: MusicTabId;
  player: PlayerController;
}

export interface TabManagerSession {
  activeId: MusicTabId | null;
  playbackOwnerId: MusicTabId | null;
  players: Record<MusicTabId, PlayerSession>;
}

type Listener = () => void;

const EMPTY_PLAYER_STATE: PlayerState = {
  status: "idle",
  currentTrack: null,
  history: [],
  error: null,
  playbackOrderMode: "in-order",
  shuffleEnabled: false,
  volume: 1,
  muted: false,
};

export class TabManager {
  private tabs = new Map<MusicTabId, MusicTab>();
  private activeId: MusicTabId | null = null;
  private playbackOwnerId: MusicTabId | null = null;
  private readonly playerUnsubscribes = new Map<MusicTabId, () => void>();
  private readonly listeners = new Set<Listener>();
  private activeSessionSnapshot: PlayerSession | null | undefined;

  get active(): MusicTab | null {
    return this.activeId ? this.tabs.get(this.activeId) ?? null : null;
  }

  constructor(private readonly dataSource: DataSource) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getActiveId(): MusicTabId | null {
    return this.activeId;
  }

  exportSession(): TabManagerSession {
    return {
      activeId: this.activeId,
      playbackOwnerId: this.playbackOwnerId,
      players: Object.fromEntries(
        [...this.tabs].map(([id, tab]) => [id, tab.player.exportSession()]),
      ),
    };
  }

  restoreSession(session: TabManagerSession): void {
    for (const [id, playerSession] of Object.entries(session.players)) {
      this.createTab(id).player.restoreSession(playerSession);
    }

    if (session.activeId && this.tabs.has(session.activeId)) {
      this.activeId = session.activeId;
    }
    if (session.playbackOwnerId && this.tabs.has(session.playbackOwnerId)) {
      this.playbackOwnerId = session.playbackOwnerId;
    } else {
      this.playbackOwnerId = this.activeId;
    }

    for (const [id, tab] of this.tabs) {
      if (id !== this.playbackOwnerId) tab.player.suspendForTabSwitch();
    }
    const playbackOwner = this.playbackOwnerId
      ? this.tabs.get(this.playbackOwnerId)
      : null;
    if (playbackOwner) void playbackOwner.player.resumeFromTabSwitch();
    this.emit();
  }

  applyPlaybackSettings(settings: PlaybackSettings): void {
    for (const tab of this.tabs.values()) {
      tab.player.applyPlaybackSettings(settings, false);
    }
    this.emit();
  }

  reset(initialId: MusicTabId): void {
    for (const tab of this.tabs.values()) {
      tab.player.dispose();
    }
    for (const unsubscribe of this.playerUnsubscribes.values()) {
      unsubscribe();
    }
    this.tabs.clear();
    this.playerUnsubscribes.clear();
    this.activeId = null;
    this.playbackOwnerId = null;
    this.activeSessionSnapshot = undefined;
    this.createTab(initialId);
  }

  getActiveState(): PlayerState {
    return this.getEffectivePlayer()?.getState() ?? EMPTY_PLAYER_STATE;
  }

  getActiveSession(): PlayerSession | null {
    if (this.activeSessionSnapshot === undefined) {
      this.activeSessionSnapshot = this.getEffectivePlayer()?.exportSession() ?? null;
    }
    return this.activeSessionSnapshot;
  }

  getActivePlayerId(): MusicTabId | null {
    const focusedPlayer = this.active?.player;
    if (focusedPlayer?.getState().currentTrack) return this.activeId;
    return this.playbackOwnerId ?? this.activeId;
  }

  getPlaybackOwnerId(): MusicTabId | null {
    return this.playbackOwnerId;
  }

  getFocusedState(): PlayerState {
    return this.active?.player.getState() ?? EMPTY_PLAYER_STATE;
  }

  getActivePlayer(): PlayerController {
    const player = this.getEffectivePlayer();
    if (!player) throw new Error("No active music tab.");
    return player;
  }

  getFocusedPlayer(): PlayerController {
    const player = this.active?.player;
    if (!player) throw new Error("No focused music tab.");
    return player;
  }

  createTab(id: MusicTabId): MusicTab {
    const existing = this.tabs.get(id);
    if (existing) return existing;

    const tab: MusicTab = { id, player: new PlayerController(this.dataSource) };
    this.tabs.set(id, tab);
    this.playerUnsubscribes.set(id, tab.player.subscribe(() => this.emit()));
    if (!this.activeId) {
      this.activeId = tab.id;
      this.playbackOwnerId = tab.id;
      void tab.player.resumeFromTabSwitch();
      this.emit();
    }
    return tab;
  }

  async setActive(id: MusicTabId): Promise<void> {
    if (this.activeId === id) return;
    const next = this.tabs.get(id);
    if (!next) return;

    this.activeId = id;
    if (next.player.getState().currentTrack) {
      await this.setPlaybackOwner(id);
    } else {
      this.emit();
    }
  }

  async claimFocusedPlayer(): Promise<PlayerController> {
    const focused = this.active;
    if (!focused) throw new Error("No focused music tab.");
    await this.setPlaybackOwner(focused.id);
    return focused.player;
  }

  removeTab(id: MusicTabId): void {
    const tab = this.tabs.get(id);
    if (!tab) return;

    tab.player.dispose();
    this.tabs.delete(id);
    this.playerUnsubscribes.get(id)?.();
    this.playerUnsubscribes.delete(id);

    if (this.activeId === id) {
      this.activeId = this.tabs.keys().next().value ?? null;
    }
    if (this.playbackOwnerId === id) {
      this.playbackOwnerId = this.activeId;
      const activePlayer = this.active?.player;
      if (activePlayer) void activePlayer.resumeFromTabSwitch();
    }
    this.emit();
  }

  private getEffectivePlayer(): PlayerController | null {
    const focusedPlayer = this.active?.player;
    if (focusedPlayer?.getState().currentTrack) return focusedPlayer;
    if (this.playbackOwnerId) {
      return this.tabs.get(this.playbackOwnerId)?.player ?? focusedPlayer ?? null;
    }
    return focusedPlayer ?? null;
  }

  private async setPlaybackOwner(id: MusicTabId): Promise<void> {
    if (this.playbackOwnerId === id) {
      this.emit();
      return;
    }

    if (this.playbackOwnerId) {
      this.tabs.get(this.playbackOwnerId)?.player.suspendForTabSwitch();
    }
    this.playbackOwnerId = id;
    const next = this.tabs.get(id);
    if (next) await next.player.resumeFromTabSwitch();
    this.emit();
  }

  private emit(): void {
    this.activeSessionSnapshot = undefined;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
