#!/usr/bin/env node

/**
 * Repo Explorer MCP Server
 * A server for exploring and managing reference repositories
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { simpleGit } from 'simple-git';
import fs from 'fs-extra';
import path from 'path';
import { globby } from 'globby';
import { 
  initCacheSystem, 
  getEnhancedRepoStatus, 
  searchCodeWithCache,
  buildRepoCache,
  isCacheValid
} from './cacheManager.js';
import {
  initConfig,
  getConfig,
  getRepoBaseDir,
  getRepositories,
  RepoStructure
} from './config.js';

/**
 * Utility function to create the reference repository structure
 */
async function ensureRepoDirectoryStructure(): Promise<boolean> {
  try {
    const repoBaseDir = getRepoBaseDir();
    const repositories = getRepositories();
    
    // Create the base directory if it doesn't exist
    await fs.ensureDir(repoBaseDir);
    
    // Create category directories
    for (const category of Object.keys(repositories)) {
      await fs.ensureDir(path.join(repoBaseDir, category));
    }
    
    return true;
  } catch (error) {
    console.error('Error creating directory structure:', error);
    return false;
  }
}

/**
 * Get the path for a specific repository
 */
function getRepoPath(category: string, repoName: string): string {
  return path.join(getRepoBaseDir(), category, repoName);
}

/**
 * Check if a repository exists
 */
async function repoExists(category: string, repoName: string): Promise<boolean> {
  try {
    const repoPath = getRepoPath(category, repoName);
    const stats = await fs.stat(repoPath);
    return stats.isDirectory();
  } catch (error) {
    return false;
  }
}

/**
 * Clone a repository
 */
async function cloneRepo(category: string, repoName: string, shallow = false): Promise<string> {
  try {
    const repositories = getRepositories();
    if (!repositories[category] || !repositories[category][repoName]) {
      throw new Error(`Repository ${category}/${repoName} not found in configuration`);
    }
    
    const repoConfig = repositories[category][repoName];
    const repoPath = getRepoPath(category, repoName);
    
    // Check if repo already exists
    if (await repoExists(category, repoName)) {
      return `Repository ${category}/${repoName} already exists at ${repoPath}`;
    }
    
    // Ensure parent directory exists
    await fs.ensureDir(path.join(getRepoBaseDir(), category));
    
    // Clone the repository
    const git = simpleGit();
    const options = shallow ? ['--depth', '1'] : [];
    await git.clone(repoConfig.url, repoPath, options);
    
    return `Repository ${category}/${repoName} cloned successfully to ${repoPath}`;
  } catch (error) {
    console.error(`Error cloning repository ${category}/${repoName}:`, error);
    throw new Error(`Failed to clone repository ${category}/${repoName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Update a repository
 */
async function updateRepo(category: string, repoName: string): Promise<string> {
  try {
    const repoPath = getRepoPath(category, repoName);
    
    // Check if repo exists
    if (!await repoExists(category, repoName)) {
      throw new Error(`Repository ${category}/${repoName} does not exist at ${repoPath}`);
    }
    
    // Pull the latest changes
    const git = simpleGit(repoPath);
    const pullResult = await git.pull();
    
    return `Repository ${category}/${repoName} updated: ${pullResult.summary.changes} changes`;
  } catch (error) {
    console.error(`Error updating repository ${category}/${repoName}:`, error);
    throw new Error(`Failed to update repository ${category}/${repoName}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

interface RepoStatus {
  exists: boolean;
  path: string;
  branch?: string;
  lastCommit?: {
    hash: string;
    date: string;
    message: string;
    author: string;
  };
  modified?: boolean;
  status?: {
    modified: string[];
    added: string[];
    deleted: string[];
  };
  error?: string;
}

/**
 * Get the status of a repository
 */
async function getRepoStatus(category: string, repoName: string): Promise<RepoStatus> {
  try {
    const repoPath = getRepoPath(category, repoName);
    
    // Check if repo exists
    if (!await repoExists(category, repoName)) {
      return {
        exists: false,
        path: repoPath,
      };
    }
    
    // Get repository info
    const git = simpleGit(repoPath);
    const [status, branch, log] = await Promise.all([
      git.status(),
      git.branch(),
      git.log({ maxCount: 1 }),
    ]);
    
    return {
      exists: true,
      path: repoPath,
      branch: branch.current,
      lastCommit: log.latest ? {
        hash: log.latest.hash,
        date: log.latest.date,
        message: log.latest.message,
        author: log.latest.author_name,
      } : undefined,
      modified: status.modified.length > 0,
      status: {
        modified: status.modified,
        added: status.created,
        deleted: status.deleted,
      },
    };
  } catch (error) {
    console.error(`Error getting repository status ${category}/${repoName}:`, error);
    return {
      exists: false,
      path: getRepoPath(category, repoName),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

interface SearchMatch {
  line: number;
  content: string;
  context: {
    line: number;
    text: string;
    isMatch: boolean;
  }[];
}

interface SearchResult {
  category: string;
  repo: string;
  file: string;
  matches: SearchMatch[];
}

/**
 * Search for code in repositories
 */
async function searchCode(
  pattern: string, 
  filePattern = '*', 
  categoryFilter?: string, 
  repoFilter?: string
): Promise<SearchResult[]> {
  try {
    const results: SearchResult[] = [];
    const repositories = getRepositories();
    const categories = categoryFilter ? [categoryFilter] : Object.keys(repositories);
    
    for (const category of categories) {
      if (!repositories[category]) continue;
      
      const repos = repoFilter && repositories[category][repoFilter] 
        ? [repoFilter] 
        : Object.keys(repositories[category]);
      
      for (const repo of repos) {
        const repoPath = getRepoPath(category, repo);
        
        // Skip if repo doesn't exist
        if (!await repoExists(category, repo)) {
          continue;
        }
        
        // Find all matching files
        const files = await globby([`**/${filePattern}`], {
          cwd: repoPath,
          gitignore: true,
          dot: false,
        });
        
        // Search through the files
        for (const file of files) {
          const filePath = path.join(repoPath, file);
          try {
            const content = await fs.readFile(filePath, 'utf-8');
            const lines = content.split('\n');
            
            // Look for matches
            const matchingLines: SearchMatch[] = [];
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].includes(pattern)) {
                // Add context (3 lines before and after)
                const start = Math.max(0, i - 3);
                const end = Math.min(lines.length - 1, i + 3);
                
                matchingLines.push({
                  line: i + 1,
                  content: lines[i],
                  context: lines.slice(start, end + 1).map((text, idx) => ({
                    line: start + idx + 1,
                    text,
                    isMatch: start + idx === i,
                  })),
                });
              }
            }
            
            if (matchingLines.length > 0) {
              results.push({
                category,
                repo,
                file,
                matches: matchingLines,
              });
            }
          } catch (error) {
            // Skip binary files or files that can't be read
            continue;
          }
        }
      }
    }
    
    return results;
  } catch (error) {
    console.error(`Error searching code:`, error);
    throw new Error(`Failed to search code: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// Create the MCP server
const server = new Server(
  {
    name: "repo-explorer",
    version: "0.1.0",
  },
  {
    capabilities: {
      resources: {},
      tools: {},
    },
  }
);

// List all repositories as resources
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  try {
    await ensureRepoDirectoryStructure();
    
    const resources = [];
    const repositories = getRepositories();
    
    // Add each repository as a resource
    for (const category of Object.keys(repositories)) {
      for (const repo of Object.keys(repositories[category])) {
        const repoConfig = repositories[category][repo];
        const exists = await repoExists(category, repo);
        
        resources.push({
          uri: `repo://${category}/${repo}`,
          mimeType: "application/json",
          name: `${category}/${repo}`,
          description: `${repoConfig.description} ${exists ? '(cloned)' : '(not cloned)'}`,
        });
      }
    }
    
    return { resources };
  } catch (error) {
    console.error('Error listing resources:', error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to list repositories: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// Read repository information
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  try {
    const match = request.params.uri.match(/^repo:\/\/([^\/]+)\/([^\/]+)$/);
    if (!match) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Invalid URI format: ${request.params.uri}`
      );
    }
    
    const category = match[1];
    const repo = match[2];
    const repositories = getRepositories();
    
    if (!repositories[category] || !repositories[category][repo]) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        `Repository ${category}/${repo} not found in configuration`
      );
    }
    
    const status = await getRepoStatus(category, repo);
    const info = {
      ...repositories[category][repo],
      ...status,
    };
    
    return {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "application/json",
          text: JSON.stringify(info, null, 2),
        },
      ],
    };
  } catch (error) {
    console.error('Error reading resource:', error);
    throw new McpError(
      ErrorCode.InternalError,
      `Failed to read repository info: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "repo_status",
        description: "Get status of all repositories or a specific repository",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "Optional category filter (e.g., 'nostr', 'react-native', 'state-management')"
            },
            repo: {
              type: "string",
              description: "Optional repository name filter"
            }
          }
        }
      },
      {
        name: "clone_repo",
        description: "Clone a specific repository",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "Category (e.g., 'nostr', 'react-native', 'state-management')"
            },
            repo: {
              type: "string",
              description: "Repository name"
            },
            shallow: {
              type: "boolean",
              description: "Whether to perform a shallow clone (default: false)"
            }
          },
          required: ["category", "repo"]
        }
      },
      {
        name: "update_repo",
        description: "Update (pull) a specific repository",
        inputSchema: {
          type: "object",
          properties: {
            category: {
              type: "string",
              description: "Category (e.g., 'nostr', 'react-native', 'state-management')"
            },
            repo: {
              type: "string",
              description: "Repository name"
            }
          },
          required: ["category", "repo"]
        }
      },
      {
        name: "create_reference_repos",
        description: "Create the reference repo structure and optionally clone all repositories",
        inputSchema: {
          type: "object",
          properties: {
            cloneAll: {
              type: "boolean",
              description: "Whether to clone all repositories (default: false)"
            },
            shallow: {
              type: "boolean",
              description: "Whether to perform shallow clones (default: false)"
            },
            category: {
              type: "string",
              description: "Optional category to limit cloning to"
            }
          }
        }
      },
      {
        name: "search_code",
        description: "Search for code across repositories",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "Search pattern"
            },
            filePattern: {
              type: "string",
              description: "Optional file pattern (e.g., '*.ts', '*.js')"
            },
            category: {
              type: "string",
              description: "Optional category filter"
            },
            repo: {
              type: "string",
              description: "Optional repository filter"
            }
          },
          required: ["pattern"]
        }
      }
    ]
  };
});

interface RepoResults {
  [key: string]: RepoStatus;
}

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    switch (request.params.name) {
      case "repo_status": {
        const args = request.params.arguments || {};
        const category = args.category as string | undefined;
        const repo = args.repo as string | undefined;
        const repositories = getRepositories();
        
        const results: any = {};
        
        if (category && repo) {
          // Specific repository
          if (!repositories[category] || !repositories[category][repo]) {
            throw new Error(`Repository ${category}/${repo} not found in configuration`);
          }
          
          // Use enhanced repo status that includes cached info
          results[`${category}/${repo}`] = await getEnhancedRepoStatus(category, repo);
        } else if (category) {
          // All repositories in a category
          if (!repositories[category]) {
            throw new Error(`Category ${category} not found in configuration`);
          }
          
          for (const r of Object.keys(repositories[category])) {
            results[`${category}/${r}`] = await getEnhancedRepoStatus(category, r);
          }
        } else {
          // All repositories
          for (const c of Object.keys(repositories)) {
            for (const r of Object.keys(repositories[c])) {
              results[`${c}/${r}`] = await getEnhancedRepoStatus(c, r);
            }
          }
        }
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(results, null, 2)
          }]
        };
      }
      
      case "clone_repo": {
        const args = request.params.arguments || {};
        const category = args.category as string;
        const repo = args.repo as string;
        const shallow = args.shallow as boolean || false;
        const repositories = getRepositories();
        
        if (!category || !repo) {
          throw new Error("Category and repo are required");
        }
        
        if (!repositories[category] || !repositories[category][repo]) {
          throw new Error(`Repository ${category}/${repo} not found in configuration`);
        }
        
        const result = await cloneRepo(category, repo, shallow);
        
        return {
          content: [{
            type: "text",
            text: result
          }]
        };
      }
      
      case "update_repo": {
        const args = request.params.arguments || {};
        const category = args.category as string;
        const repo = args.repo as string;
        const repositories = getRepositories();
        
        if (!category || !repo) {
          throw new Error("Category and repo are required");
        }
        
        if (!repositories[category] || !repositories[category][repo]) {
          throw new Error(`Repository ${category}/${repo} not found in configuration`);
        }
        
        const result = await updateRepo(category, repo);
        
        return {
          content: [{
            type: "text",
            text: result
          }]
        };
      }
      
      case "create_reference_repos": {
        const args = request.params.arguments || {};
        const cloneAll = args.cloneAll as boolean;
        const shallow = args.shallow as boolean || false;
        const category = args.category as string | undefined;
        const repositories = getRepositories();
        
        // Create the directory structure
        await ensureRepoDirectoryStructure();
        
        if (!cloneAll) {
          return {
            content: [{
              type: "text",
              text: `Reference repository structure created at ${getRepoBaseDir()}`
            }]
          };
        }
        
        // Clone all repositories (optionally filtered by category)
        const categories = category ? [category] : Object.keys(repositories);
        const results: string[] = [];
        
        for (const c of categories) {
          if (!repositories[c]) {
            results.push(`Category ${c} not found in configuration`);
            continue;
          }
          
          for (const r of Object.keys(repositories[c])) {
            try {
              const result = await cloneRepo(c, r, shallow);
              results.push(result);
            } catch (error) {
              results.push(`Error cloning ${c}/${r}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
        
        return {
          content: [{
            type: "text",
            text: results.join('\n')
          }]
        };
      }
      
      case "search_code": {
        const args = request.params.arguments || {};
        const pattern = args.pattern as string;
        const filePattern = args.filePattern as string || '*';
        const category = args.category as string | undefined;
        const repo = args.repo as string | undefined;
        
        if (!pattern) {
          throw new Error("Search pattern is required");
        }
        
        // Use cached search if available
        const results = await searchCodeWithCache(
          pattern,
          filePattern,
          category,
          repo,
          getRepositories()
        );
        
        return {
          content: [{
            type: "text",
            text: JSON.stringify(results, null, 2)
          }]
        };
      }
      
      default:
        throw new Error(`Unknown tool: ${request.params.name}`);
    }
  } catch (error) {
    console.error(`Error executing tool ${request.params.name}:`, error);
    return {
      content: [{
        type: "text",
        text: `Error: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
});

// Start the server
async function main() {
  try {
    // Initialize the config
    await initConfig();
    console.error('Configuration loaded from', path.join(process.env.HOME || '~', '.repo-explorer.json'));
    
    // Ensure the base directory structure exists
    await ensureRepoDirectoryStructure();

    // Initialize the cache system
    await initCacheSystem();
    console.error('Repository cache system initialized');
    
    // Start the server
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('Repo Explorer MCP server running on stdio');
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

main();
