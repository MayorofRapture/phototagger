import type { Configuration } from 'webpack';
import { rules } from './webpack.rules';

export const mainConfig: Configuration = {
  entry: './src/main/main.ts',
  module: {
    rules,
  },
  resolve: {
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.json'],
  },
  externals: {
    'better-sqlite3': 'commonjs better-sqlite3',
    'sharp': 'commonjs sharp',
  },
};
