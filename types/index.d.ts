// A file this session edited or deleted, with the last action taken on it.
export type ChangedFile = {
  path: string;
  kind: 'edited' | 'deleted';
  at: number;
};

// A refined suggestion for the draft it was made from.
export type Suggestion = {
  for: string;
  text: string;
};

declare module 'claude-code' {
  interface PluginState {
    'session-hub': {
      isRefining: Shaped<boolean>;
      files: Shaped<ChangedFile[]>;
      collapsed: Shaped<string[]>;
      promptAt: Shaped<number>;
      collapsedAll: Shaped<boolean>;
      expanded: Shaped<string[]>;
      selected: Shaped<string>;
      refineStatus: Shaped<string>;
      suggestion: Shaped<Suggestion | null>;
      currentDraft: Shaped<string>;
      treeSnapshot: Shaped<string>;
      treeFilter: Shaped<string>;
      treeOffset: Shaped<number>;
      searchOpen: Shaped<boolean>;
      tick: Shaped<number>;
    };
  }
}




