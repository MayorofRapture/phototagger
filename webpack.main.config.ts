import type { Configuration } from 'webpack';
import { rules } from './webpack.rules';

export const mainConfig: Configuration = {
  entry: {
    index: './src/main/main.ts',
    catalog_process: './src/catalog/catalog-process.ts',
  },
  output: {
    filename: '[name].js',
  },
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
