import fs from 'fs-extra';
import path from 'path';
import { simpleGit } from 'simple-git';
import { globby } from 'globby';
import { getRepoBaseDir, getRepositories } from './config.js';

// Cache directory within the base directory
function getCacheDir(): string {
  return path.join(getRepoBaseDir(), '.cache');
}

// Repository metadata structure
export interface RepoMetadata {
  lastCommitHash: string;          // For cache invalidation
  lastScanned: string;             // ISO date
  stats: {
    totalFiles: number;
    totalSize: number;
    languages: Record<string, number>; // language → line count
    directoryCount: number;
  };
  packageInfo?: {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
}

// File structure index
export interface FileStructure {
  directories: {
    [path: string]: {
      files: string[];
      subdirectories: string[];
    }
  };
  files: {
    [path: string]: {
      size: number;
      lastModified: string;
      language: string;
      importedModules?: string[];
      exportedSymbols?: string[];
    }
  };
}

// Search index
export interface SearchIndex {
  exactTerms: {
    [term: string]: Array<{
      file: string;
      occurrences: number;
      positions: number[]; // Line numbers
    }>
  };
  terms: {
    [term: string]: Array<{
      file: string;
      occurrences: number;
      positions: number[]; // Line numbers
    }>
  };
}

// Code structure index
export interface CodeStructureIndex {
  classes: Array<{
    name: string;
    file: string;
    extends?: string;
    implements?: string[];
    methods: string[];
    properties: string[];
  }>;
  functions: Array<{
    name: string;
    file: string;
    exported: boolean;
  }>;
  imports: Record<string, string[]>; // module → files that import it
  exports: Record<string, string[]>; // exported symbol → files that export it
  mostImportedModules: Array<{
    module: string;
    count: number;
  }>;
}

// Full repository cache
export interface RepoCache {
  metadata: RepoMetadata;
  structure: FileStructure;
  searchIndex: SearchIndex;
  codeStructure: CodeStructureIndex;
}

// File extension to language mapping
const LANGUAGE_MAP: Record<string, string> = {
  '.js': 'JavaScript',
  '.jsx': 'JavaScript (React)',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript (React)',
  '.java': 'Java',
  '.swift': 'Swift',
  '.kt': 'Kotlin',
  '.m': 'Objective-C',
  '.h': 'C/C++ Header',
  '.c': 'C',
  '.cpp': 'C++',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.go': 'Go',
  '.rs': 'Rust',
  '.php': 'PHP',
  '.html': 'HTML',
  '.css': 'CSS',
  '.scss': 'SCSS',
  '.json': 'JSON',
  '.md': 'Markdown',
  '.yml': 'YAML',
  '.yaml': 'YAML',
  '.xml': 'XML',
  '.sh': 'Shell',
  '.bat': 'Batch',
  '.ps1': 'PowerShell',
};

/**
 * Get the path to a repository
 */
export function getRepoPath(category: string, repoName: string): string {
  return path.join(getRepoBaseDir(), category, repoName);
}

/**
 * Get the path to a cache file
 */
export function getCachePath(category: string, repo: string, file: string): string {
  const cachePath = path.join(getCacheDir(), category, repo);
  return path.join(cachePath, file);
}

/**
 * Check if the cache for a repository is valid
 */
export async function isCacheValid(category: string, repo: string): Promise<boolean> {
  try {
    const metadataPath = getCachePath(category, repo, 'metadata.json');
    if (!await fs.pathExists(metadataPath)) return false;
    
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf-8')) as RepoMetadata;
    
    // Check if repo has been updated since last cache
    const git = simpleGit(getRepoPath(category, repo));
    const currentHash = (await git.revparse(['HEAD'])).trim();
    
    return metadata.lastCommitHash === currentHash;
  } catch (error) {
    console.error(`Error checking cache validity for ${category}/${repo}:`, error);
    return false; // Any error means cache is invalid
  }
}

/**
 * Scan the file structure of a repository
 */
async function scanFileStructure(repoPath: string): Promise<FileStructure> {
  const structure: FileStructure = {
    directories: {},
    files: {}
  };
  
  // Get all files in the repository
  const files = await globby(['**/*'], {
    cwd: repoPath,
    gitignore: true,
    dot: false,
    onlyFiles: true,
  });
  
  // Build directory structure
  const directories = new Set<string>();
  
  for (const file of files) {
    const filePath = path.join(repoPath, file);
    const stats = await fs.stat(filePath);
    const ext = path.extname(file).toLowerCase();
    
    // Add file to structure
    structure.files[file] = {
      size: stats.size,
      lastModified: stats.mtime.toISOString(),
      language: LANGUAGE_MAP[ext] || 'Unknown',
    };
    
    // Add directories
    let dirPath = path.dirname(file);
    while (dirPath && dirPath !== '.') {
      directories.add(dirPath);
      dirPath = path.dirname(dirPath);
    }
  }
  
  // Process directories
  for (const dir of directories) {
    const dirPath = path.join(repoPath, dir);
    const contents = await fs.readdir(dirPath);
    
    const files = [];
    const subdirectories = [];
    
    for (const item of contents) {
      const itemPath = path.join(dirPath, item);
      const stats = await fs.stat(itemPath);
      
      if (stats.isDirectory()) {
        subdirectories.push(item);
      } else {
        files.push(item);
      }
    }
    
    structure.directories[dir] = {
      files,
      subdirectories,
    };
  }
  
  return structure;
}

/**
 * Build a search index for a repository
 */
async function buildSearchIndex(repoPath: string, structure: FileStructure): Promise<SearchIndex> {
  const searchIndex: SearchIndex = {
    exactTerms: {},
    terms: {}
  };
  
  // Process each file
  for (const [file, info] of Object.entries(structure.files)) {
    // Skip binary files and very large files
    if (info.size > 1024 * 1024) continue; // Skip files > 1MB
    if (!/\.(js|jsx|ts|tsx|java|kt|swift|c|cpp|h|py|rb|go|rs|php|html|css|md|json|yml|yaml|xml|sh)$/i.test(file)) {
      continue;
    }
    
    try {
      const filePath = path.join(repoPath, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      
      // Extract significant terms and track their positions
      const processedTerms = new Set<string>();
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Extract words and code identifiers
        const identifiers = line.match(/[a-zA-Z_$][a-zA-Z0-9_$]*/g) || [];
        
        for (const term of identifiers) {
          // Skip common words and short terms
          if (term.length < 3 || /^(the|and|for|function|var|let|const|if|else|while|return|this|new|try|catch|class|import|export)$/i.test(term)) {
            continue;
          }
          
          // Add to exact terms index
          if (!searchIndex.exactTerms[term]) {
            searchIndex.exactTerms[term] = [];
          }
          
          // Check if we've already processed this term for this file
          const termFileKey = `${term}:${file}`;
          if (!processedTerms.has(termFileKey)) {
            searchIndex.exactTerms[term].push({
              file,
              occurrences: 1,
              positions: [i + 1] // Line numbers are 1-based
            });
            processedTerms.add(termFileKey);
          } else {
            // Update existing entry
            const entry = searchIndex.exactTerms[term].find(e => e.file === file);
            if (entry) {
              entry.occurrences++;
              entry.positions.push(i + 1);
            }
          }
          
          // Handle camelCase and snake_case terms
          const subTerms = term.split(/(?=[A-Z])/).filter(t => t.length > 2);
          const snakeTerms = term.split('_').filter(t => t.length > 2);
          const allTerms = [...subTerms, ...snakeTerms];
          
          for (const subTerm of allTerms) {
            if (!searchIndex.terms[subTerm.toLowerCase()]) {
              searchIndex.terms[subTerm.toLowerCase()] = [];
            }
            
            const entry = searchIndex.terms[subTerm.toLowerCase()].find(e => e.file === file);
            if (entry) {
              entry.occurrences++;
              if (!entry.positions.includes(i + 1)) {
                entry.positions.push(i + 1);
              }
            } else {
              searchIndex.terms[subTerm.toLowerCase()].push({
                file,
                occurrences: 1,
                positions: [i + 1]
              });
            }
          }
        }
      }
    } catch (error) {
      // Skip files that can't be read
      console.error(`Error indexing file ${file}:`, error);
      continue;
    }
  }
  
  return searchIndex;
}

/**
 * Very basic code structure analysis
 * For simplicity, we're using regex patterns to identify classes and functions
 * A more robust solution would use language-specific parsers
 */
async function analyzeCodeStructure(repoPath: string, structure: FileStructure): Promise<CodeStructureIndex> {
  const codeStructure: CodeStructureIndex = {
    classes: [],
    functions: [],
    imports: {},
    exports: {},
    mostImportedModules: []
  };
  
  const moduleImportCounts: Record<string, number> = {};
  
  // Process each file
  for (const [file, info] of Object.entries(structure.files)) {
    // Skip non-code files
    if (!/\.(js|jsx|ts|tsx|java|kt|swift)$/i.test(file)) continue;
    
    try {
      const filePath = path.join(repoPath, file);
      const content = await fs.readFile(filePath, 'utf-8');
      const lines = content.split('\n');
      
      // Detect imports/requires
      const importedModules: string[] = [];
      for (const line of lines) {
        // ES6 imports
        const importMatches = line.match(/import\s+.*?\s+from\s+['"]([^'"]+)['"]/);
        if (importMatches) {
          const module = importMatches[1];
          importedModules.push(module);
          
          if (!codeStructure.imports[module]) {
            codeStructure.imports[module] = [];
          }
          if (!codeStructure.imports[module].includes(file)) {
            codeStructure.imports[module].push(file);
          }
          
          moduleImportCounts[module] = (moduleImportCounts[module] || 0) + 1;
        }
        
        // CommonJS requires
        const requireMatches = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        if (requireMatches) {
          const module = requireMatches[1];
          importedModules.push(module);
          
          if (!codeStructure.imports[module]) {
            codeStructure.imports[module] = [];
          }
          if (!codeStructure.imports[module].includes(file)) {
            codeStructure.imports[module].push(file);
          }
          
          moduleImportCounts[module] = (moduleImportCounts[module] || 0) + 1;
        }
      }
      
      // Add imported modules to file info
      structure.files[file].importedModules = importedModules;
      
      // Detect classes using simple regex
      // This is a simplification - a real implementation would use language parsers
      const classRegex = /class\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:extends\s+([A-Za-z_$][A-Za-z0-9_$]*))?/g;
      let classMatch;
      while ((classMatch = classRegex.exec(content)) !== null) {
        const className = classMatch[1];
        const extendsClass = classMatch[2];
        
        // Find methods within the class (very basic implementation)
        const classStartIndex = classMatch.index + classMatch[0].length;
        let braceCount = 0;
        let classEndIndex = classStartIndex;
        
        // Find the class body by matching braces
        for (let i = classStartIndex; i < content.length; i++) {
          if (content[i] === '{') braceCount++;
          else if (content[i] === '}') {
            braceCount--;
            if (braceCount === 0) {
              classEndIndex = i;
              break;
            }
          }
        }
        
        // Extract the class body
        const classBody = content.substring(classStartIndex, classEndIndex);
        
        // Extract methods and properties
        const methodRegex = /(?:async\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*{/g;
        const propertyRegex = /([A-Za-z_$][A-Za-z0-9_$]*)\s*[=:]/g;
        
        const methods: string[] = [];
        const properties: string[] = [];
        
        let methodMatch;
        while ((methodMatch = methodRegex.exec(classBody)) !== null) {
          methods.push(methodMatch[1]);
        }
        
        let propertyMatch;
        while ((propertyMatch = propertyRegex.exec(classBody)) !== null) {
          // Skip common keywords
          if (!/^(if|else|return|const|let|var|this|function|class|for|while)$/.test(propertyMatch[1])) {
            properties.push(propertyMatch[1]);
          }
        }
        
        // Add to class index
        codeStructure.classes.push({
          name: className,
          file,
          extends: extendsClass,
          methods,
          properties
        });
        
        // Add to exports
        if (!codeStructure.exports[className]) {
          codeStructure.exports[className] = [];
        }
        codeStructure.exports[className].push(file);
      }
      
      // Detect functions
      const functionRegex = /(?:export\s+)?(?:function|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:=\s*(?:async\s*)?\([^)]*\)|[^=]*=\s*(?:async\s*)?\([^)]*\)|(?:async\s*)?\([^)]*\))/g;
      let functionMatch;
      while ((functionMatch = functionRegex.exec(content)) !== null) {
        const functionName = functionMatch[1];
        // Skip react hook variables and known patterns
        if (/^(use[A-Z]|set[A-Z]|if|else|return|const|let|var|this|function|class|for|while)$/.test(functionName)) {
          continue;
        }
        
        const isExported = functionMatch[0].includes('export');
        
        codeStructure.functions.push({
          name: functionName,
          file,
          exported: isExported
        });
        
        // Add exported functions to the exports index
        if (isExported) {
          if (!codeStructure.exports[functionName]) {
            codeStructure.exports[functionName] = [];
          }
          codeStructure.exports[functionName].push(file);
          
          // Add to file exports
          if (!structure.files[file].exportedSymbols) {
            structure.files[file].exportedSymbols = [];
          }
          structure.files[file].exportedSymbols!.push(functionName);
        }
      }
      
      // Detect exports
      const exportRegex = /export\s+(?:default\s+)?(?:const|let|var|class|function)?\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;
      let exportMatch;
      while ((exportMatch = exportRegex.exec(content)) !== null) {
        const exportName = exportMatch[1];
        
        if (!codeStructure.exports[exportName]) {
          codeStructure.exports[exportName] = [];
        }
        if (!codeStructure.exports[exportName].includes(file)) {
          codeStructure.exports[exportName].push(file);
        }
        
        // Add to file exports
        if (!structure.files[file].exportedSymbols) {
          structure.files[file].exportedSymbols = [];
        }
        if (!structure.files[file].exportedSymbols!.includes(exportName)) {
          structure.files[file].exportedSymbols!.push(exportName);
        }
      }
    } catch (error) {
      // Skip files that can't be read
      console.error(`Error analyzing code structure for ${file}:`, error);
      continue;
    }
  }
  
  // Calculate most imported modules
  codeStructure.mostImportedModules = Object.entries(moduleImportCounts)
    .map(([module, count]) => ({ module, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  
  return codeStructure;
}

/**
 * Get repository metadata
 */
async function getRepositoryMetadata(repoPath: string, structure: FileStructure): Promise<RepoMetadata> {
  const git = simpleGit(repoPath);
  const currentHash = (await git.revparse(['HEAD'])).trim();
  
  // Calculate statistics
  const stats = {
    totalFiles: Object.keys(structure.files).length,
    totalSize: Object.values(structure.files).reduce((sum, file) => sum + file.size, 0),
    languages: {} as Record<string, number>,
    directoryCount: Object.keys(structure.directories).length
  };
  
  // Count files by language
  for (const file of Object.values(structure.files)) {
    if (!stats.languages[file.language]) {
      stats.languages[file.language] = 0;
    }
    stats.languages[file.language]++;
  }
  
  // Try to parse package.json if it exists
  let packageInfo = undefined;
  try {
    const packageJsonPath = path.join(repoPath, 'package.json');
    if (await fs.pathExists(packageJsonPath)) {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf-8'));
      packageInfo = {
        dependencies: packageJson.dependencies || {},
        devDependencies: packageJson.devDependencies || {}
      };
    }
  } catch (error) {
    console.error('Error parsing package.json:', error);
  }
  
  return {
    lastCommitHash: currentHash,
    lastScanned: new Date().toISOString(),
    stats,
    packageInfo
  };
}

/**
 * Build the cache for a repository
 */
export async function buildRepoCache(category: string, repo: string): Promise<RepoCache | null> {
  try {
    console.log(`Building cache for ${category}/${repo}...`);
    const repoPath = getRepoPath(category, repo);
    
    // Scan file structure
    const structure = await scanFileStructure(repoPath);
    console.log(`File structure scan complete: ${Object.keys(structure.files).length} files`);
    
    // Build indexes
    const searchIndex = await buildSearchIndex(repoPath, structure);
    console.log(`Search index build complete: ${Object.keys(searchIndex.exactTerms).length} exact terms, ${Object.keys(searchIndex.terms).length} terms`);
    
    // Analyze code
    const codeStructure = await analyzeCodeStructure(repoPath, structure);
    console.log(`Code structure analysis complete: ${codeStructure.classes.length} classes, ${codeStructure.functions.length} functions`);
    
    // Get metadata
    const metadata = await getRepositoryMetadata(repoPath, structure);
    console.log(`Metadata collected`);
    
    // Create cache object
    const cache: RepoCache = {
      metadata,
      structure,
      searchIndex,
      codeStructure
    };
    
    // Save cache to disk
    await saveRepoCache(category, repo, cache);
    console.log(`Cache saved for ${category}/${repo}`);
    
    return cache;
  } catch (error) {
    console.error(`Error building cache for ${category}/${repo}:`, error);
    return null;
  }
}

/**
 * Save repository cache to disk
 */
async function saveRepoCache(category: string, repo: string, cache: RepoCache): Promise<void> {
  const cachePath = path.join(getCacheDir(), category, repo);
  
  // Ensure cache directory exists
  await fs.ensureDir(cachePath);
  
  // Save individual cache files to avoid loading everything at once
  await Promise.all([
    fs.writeFile(
      path.join(cachePath, 'metadata.json'),
      JSON.stringify(cache.metadata, null, 2)
    ),
    fs.writeFile(
      path.join(cachePath, 'structure.json'),
      JSON.stringify(cache.structure, null, 2)
    ),
    fs.writeFile(
      path.join(cachePath, 'searchIndex.json'),
      JSON.stringify(cache.searchIndex, null, 2)
    ),
    fs.writeFile(
      path.join(cachePath, 'codeStructure.json'),
      JSON.stringify(cache.codeStructure, null, 2)
    )
  ]);
}

/**
 * Load repository cache from disk
 */
export async function loadRepoCache(category: string, repo: string): Promise<RepoCache | null> {
  try {
    const cachePath = path.join(getCacheDir(), category, repo);
    
    // Check if cache exists
    if (!await fs.pathExists(cachePath)) {
      return null;
    }
    
    // Load individual cache files
    const [metadata, structure, searchIndex, codeStructure] = await Promise.all([
      fs.readFile(path.join(cachePath, 'metadata.json'), 'utf-8').then(JSON.parse),
      fs.readFile(path.join(cachePath, 'structure.json'), 'utf-8').then(JSON.parse),
      fs.readFile(path.join(cachePath, 'searchIndex.json'), 'utf-8').then(JSON.parse),
      fs.readFile(path.join(cachePath, 'codeStructure.json'), 'utf-8').then(JSON.parse)
    ]);
    
    return {
      metadata,
      structure,
      searchIndex,
      codeStructure
    };
  } catch (error) {
    console.error(`Error loading cache for ${category}/${repo}:`, error);
    return null;
  }
}

/**
 * Load specific part of the repository cache
 */
export async function loadRepoCachePart<T>(
  category: string, 
  repo: string, 
  part: 'metadata' | 'structure' | 'searchIndex' | 'codeStructure'
): Promise<T | null> {
  try {
    const cachePath = path.join(getCacheDir(), category, repo);
    
    // Check if cache exists
    if (!await fs.pathExists(path.join(cachePath, `${part}.json`))) {
      return null;
    }
    
    // Load the specific cache file
    return JSON.parse(await fs.readFile(path.join(cachePath, `${part}.json`), 'utf-8'));
  } catch (error) {
    console.error(`Error loading ${part} for ${category}/${repo}:`, error);
    return null;
  }
}

/**
 * Initialize cache system by ensuring cache directory exists
 */
export async function initCacheSystem(): Promise<void> {
  await fs.ensureDir(getCacheDir());
}

/**
 * Get enhanced repository status that includes cached information
 */
export async function getEnhancedRepoStatus(category: string, repoName: string): Promise<any> {
  try {
    const repoPath = getRepoPath(category, repoName);
    
    // Basic git operations (similar to original getRepoStatus)
    let result: any = {
      exists: await fs.pathExists(repoPath),
      path: repoPath,
    };
    
    if (!result.exists) {
      return result;
    }
    
    // Get repository info
    const git = simpleGit(repoPath);
    const [status, branch, log] = await Promise.all([
      git.status(),
      git.branch(),
      git.log({ maxCount: 1 }),
    ]);
    
    // Basic git status
    result = {
      ...result,
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
    
    // Check if we have cache and add enhanced information
    if (await isCacheValid(category, repoName)) {
      const metadata = await loadRepoCachePart<RepoMetadata>(category, repoName, 'metadata');
      const codeStructure = await loadRepoCachePart<CodeStructureIndex>(category, repoName, 'codeStructure');
      
      if (metadata) {
        result.stats = metadata.stats;
        result.packageInfo = metadata.packageInfo;
      }
      
      if (codeStructure) {
        result.codeInsights = {
          classCount: codeStructure.classes.length,
          functionCount: codeStructure.functions.length,
          topModules: codeStructure.mostImportedModules.slice(0, 5),
        };
      }
    }
    
    return result;
  } catch (error) {
    console.error(`Error getting enhanced repository status ${category}/${repoName}:`, error);
    return {
      exists: false,
      path: getRepoPath(category, repoName),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Search code using the cache if available
 */
export async function searchCodeWithCache(
  pattern: string, 
  filePattern = '*', 
  categoryFilter?: string, 
  repoFilter?: string,
  repositories?: any
): Promise<any[]> {
  try {
    const results: any[] = [];
    const repoConfig = repositories || getRepositories();
    const categories = categoryFilter ? [categoryFilter] : Object.keys(repoConfig);
    
    for (const category of categories) {
      // Check if category exists
      if (repoConfig && !repoConfig[category]) continue;
      
      const repos = repoFilter 
        ? [repoFilter] 
        : (repoConfig && repoConfig[category] ? Object.keys(repoConfig[category]) : []);
      
      for (const repo of repos) {
        const repoPath = getRepoPath(category, repo);
        
        // Skip if repo doesn't exist
        if (!await fs.pathExists(repoPath)) {
          continue;
        }
        
        // Try to use cache
        if (await isCacheValid(category, repo)) {
          const searchIndex = await loadRepoCachePart<SearchIndex>(category, repo, 'searchIndex');
          
          if (searchIndex) {
            // Direct term lookup
            if (searchIndex.exactTerms[pattern]) {
              for (const match of searchIndex.exactTerms[pattern]) {
                // Filter by file pattern if needed
                if (filePattern !== '*') {
                  // Simple pattern matching for file paths
                  const fileRegex = new RegExp(filePattern.replace(/\*/g, '.*'));
                  if (!fileRegex.test(match.file)) {
                    continue;
                  }
                }
                
                // Get file content for context
                try {
                  const filePath = path.join(repoPath, match.file);
                  const content = await fs.readFile(filePath, 'utf-8');
                  const lines = content.split('\n');
                  
                  // Create context for each position
                  for (const position of match.positions) {
                    const line = position - 1; // Convert to 0-based
                    
                    // Skip invalid line numbers
                    if (line < 0 || line >= lines.length) continue;
                    
                    const start = Math.max(0, line - 3);
                    const end = Math.min(lines.length - 1, line + 3);
                    
                    results.push({
                      category,
                      repo,
                      file: match.file,
                      matches: [{
                        line: position,
                        content: lines[line],
                        context: lines.slice(start, end + 1).map((text, idx) => ({
                          line: start + idx + 1,
                          text,
                          isMatch: start + idx === line,
                        })),
                      }]
                    });
                  }
                } catch (error) {
                  console.error(`Error reading file ${match.file} for context:`, error);
                  continue;
                }
              }
            }
            
            // Try regex search across all terms if exact match not found
            if (results.length === 0) {
              try {
                const regExp = new RegExp(pattern, 'i');
                
                for (const term of Object.keys(searchIndex.terms)) {
                  if (regExp.test(term)) {
                    for (const match of searchIndex.terms[term]) {
                      // Filter by file pattern
                      if (filePattern !== '*') {
                        const fileRegex = new RegExp(filePattern.replace(/\*/g, '.*'));
                        if (!fileRegex.test(match.file)) {
                          continue;
                        }
                      }
                      
                      // Get file content for context (similar to above)
                      try {
                        const filePath = path.join(repoPath, match.file);
                        const content = await fs.readFile(filePath, 'utf-8');
                        const lines = content.split('\n');
                        
                        for (const position of match.positions) {
                          const line = position - 1;
                          if (line < 0 || line >= lines.length) continue;
                          
                          const start = Math.max(0, line - 3);
                          const end = Math.min(lines.length - 1, line + 3);
                          
                          results.push({
                            category,
                            repo,
                            file: match.file,
                            matches: [{
                              line: position,
                              content: lines[line],
                              context: lines.slice(start, end + 1).map((text, idx) => ({
                                line: start + idx + 1,
                                text,
                                isMatch: start + idx === line,
                              })),
                            }]
                          });
                        }
                      } catch (error) {
                        console.error(`Error reading file ${match.file} for context:`, error);
                        continue;
                      }
                    }
                  }
                }
              } catch (error) {
                console.error('Error in regex search:', error);
              }
            }
          }
        } else {
          // Cache invalid or not present - fall back to direct file scanning
          console.log(`Cache not valid for ${category}/${repo}, falling back to direct scanning`);
          
          // Scan files directly (simplified version of the original searchCode)
          const files = await globby([`**/${filePattern}`], {
            cwd: repoPath,
            gitignore: true,
            dot: false,
          });
          
          for (const file of files) {
            const filePath = path.join(repoPath, file);
            try {
              const content = await fs.readFile(filePath, 'utf-8');
              const lines = content.split('\n');
              
              const matchingLines = [];
              
              for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(pattern)) {
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
          
          // Build cache in the background for next time
          setTimeout(() => {
            buildRepoCache(category, repo).catch(console.error);
          }, 100);
        }
      }
    }
    
    return results;
  } catch (error) {
    console.error(`Error searching code with cache:`, error);
    return [];
  }
}
