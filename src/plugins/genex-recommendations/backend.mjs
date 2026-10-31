// This plugin is skills only: Studio answers its skill tool itself, so the backend has nothing to do.
export async function activate() {
  return {
    async tool(name) {
      throw new Error(`genex-recommendations has no tool ${name}`);
    },
    async action(name) {
      throw new Error(`genex-recommendations has no action ${name}`);
    },
  };
}
