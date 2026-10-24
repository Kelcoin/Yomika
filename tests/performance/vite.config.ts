import config from '../../vite.config';

export default {
  ...config,
  server: {
    ...config.server,
    watch: { ignored: ['**/src-tauri/**'] },
  },
};
