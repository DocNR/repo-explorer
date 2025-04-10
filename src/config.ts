import path from 'path';
import fs from 'fs-extra';
import os from 'os';

// Default configuration
const defaultConfig = {
  // Base directory for all reference repositories - defaults to ~/referencerepos
  repoBaseDir: path.join(os.homedir(), 'referencerepos'),
  
  // Repository structure configuration
  repositories: {
    nostr: {
      ndk: {
        url: 'https://github.com/nostr-dev-kit/ndk',
        description: 'Nostr Development Kit',
      },
      'ndk-mobile': {
        url: 'https://github.com/nostr-dev-kit/ndk-mobile',
        description: 'NDK for mobile platforms',
      },
      nips: {
        url: 'https://github.com/nostr-protocol/nips',
        description: 'Nostr Implementation Possibilities',
      },
      olas: {
        url: 'https://github.com/pablof7z/olas',
        description: 'Olas - Nostr-based platform',
      },
    },
    databases: {
      watermelondb: {
        url: 'https://github.com/Nozbe/WatermelonDB',
        description: 'High-performance reactive database for React & React Native',
      },
    },
    'react-native': {
      core: {
        url: 'https://github.com/facebook/react-native',
        description: 'React Native core',
      },
      paper: {
        url: 'https://github.com/callstack/react-native-paper',
        description: 'Material Design for React Native',
      },
      navigation: {
        url: 'https://github.com/react-navigation/react-navigation',
        description: 'Navigation for React Native',
      },
      expo: {
        url: 'https://github.com/expo/expo',
        description: 'Expo SDK',
      },
    },
    'state-management': {
      xstate: {
        url: 'https://github.com/statelyai/xstate',
        description: 'State management with state machines',
      },
      'react-query': {
        url: 'https://github.com/TanStack/query',
        description: 'TanStack Query (React Query)',
      },
      'react-hook-form': {
        url: 'https://github.com/react-hook-form/react-hook-form',
        description: 'Form management for React',
      },
    },
  }
};

// Interface for repository configuration
export interface RepoConfig {
  url: string;
  description: string;
}

export interface CategoryConfig {
  [repoName: string]: RepoConfig;
}

export interface RepoStructure {
  [category: string]: CategoryConfig;
}

// Configuration interface
export interface Config {
  repoBaseDir: string;
  repositories: RepoStructure;
}

// Path to config file - stored in user's home directory
const CONFIG_PATH = path.join(os.homedir(), '.repo-explorer.json');

/**
 * Load configuration from file or create default if it doesn't exist
 */
export async function loadConfig(): Promise<Config> {
  try {
    // Check if config file exists
    if (await fs.pathExists(CONFIG_PATH)) {
      const configData = await fs.readFile(CONFIG_PATH, 'utf-8');
      const config = JSON.parse(configData) as Partial<Config>;
      
      // Merge with defaults to ensure all fields exist
      return {
        ...defaultConfig,
        ...config,
        // Deep merge repositories
        repositories: {
          ...defaultConfig.repositories,
          ...config.repositories
        }
      };
    }
    
    // Config doesn't exist, create it with defaults
    await fs.writeFile(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
    return defaultConfig;
  } catch (error) {
    console.error('Error loading configuration:', error);
    return defaultConfig;
  }
}

/**
 * Save configuration to file
 */
export async function saveConfig(config: Config): Promise<void> {
  try {
    await fs.writeFile(CONFIG_PATH, JSON.stringify(config, null, 2));
  } catch (error) {
    console.error('Error saving configuration:', error);
  }
}

// Load the configuration
let config: Config = defaultConfig;

// Initialize configuration
export async function initConfig(): Promise<Config> {
  config = await loadConfig();
  return config;
}

// Get the current configuration
export function getConfig(): Config {
  return config;
}

// Get repository base directory
export function getRepoBaseDir(): string {
  return config.repoBaseDir;
}

// Get repositories configuration
export function getRepositories(): RepoStructure {
  return config.repositories;
}
