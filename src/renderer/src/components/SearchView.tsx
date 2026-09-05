import { useState } from 'react'
import { CaseSensitive, Regex, Search, WholeWord } from 'lucide-react'
import type { SearchMatch } from '../../../shared/contracts'

export function SearchView({ root, onOpen }: { root: string; onOpen(path: string, line?: number, column?: number): void }) {
  const [query, setQuery] = useState('')
  const [replacement, setReplacement] = useState('')
  const [replaceVisible, setReplaceVisible] = useState(false)
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [regex, setRegex] = useState(false)
  const [include, setInclude] = useState('')
  const [exclude, setExclude] = useState('')
  const [results, setResults] = useState<SearchMatch[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const search = async (): Promise<void> => {
    if (!query.trim()) return setResults([])
    setLoading(true); setError(''); setNotice('')
    try { setResults(await window.omnicode.workspace.search(root, query, { caseSensitive, wholeWord, regex, include, exclude })) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }
  return <div className="sidebar-view search-view">
    <div className="sidebar-title">Search</div>
    <button className="replace-disclosure" type="button" onClick={() => setReplaceVisible((value) => !value)} aria-expanded={replaceVisible}>{replaceVisible ? '▾' : '▸'} Replace</button>
    <form className="search-box" onSubmit={(event) => { event.preventDefault(); void search() }}>
      <input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search workspace" aria-label="Search workspace" />
      <div className="search-options"><button className={caseSensitive ? 'active' : ''} type="button" title="Match case" aria-pressed={caseSensitive} onClick={() => setCaseSensitive((value) => !value)}><CaseSensitive /></button><button className={wholeWord ? 'active' : ''} type="button" title="Whole word" aria-pressed={wholeWord} onClick={() => setWholeWord((value) => !value)}><WholeWord /></button><button className={regex ? 'active' : ''} type="button" title="Regular expression" aria-pressed={regex} onClick={() => setRegex((value) => !value)}><Regex /></button></div>
      <button className="search-submit" title="Search" aria-label="Search" type="submit"><Search /></button>
    </form>
    {replaceVisible && <div className="replace-box"><input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder="Replace" aria-label="Replace with" /><button disabled={!results.length} onClick={async () => {
      if (!window.confirm(`Replace ${results.length} matching line${results.length === 1 ? '' : 's'} across the workspace? This action writes files to disk.`)) return
      setLoading(true); setError(''); setNotice('')
      try {
        const result = await window.omnicode.workspace.replaceAll(root, query, replacement, { caseSensitive, wholeWord, regex, include, exclude })
        setNotice(`Replaced ${result.replacements} occurrence${result.replacements === 1 ? '' : 's'} in ${result.filesChanged} file${result.filesChanged === 1 ? '' : 's'}.`)
        await search()
      } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
      finally { setLoading(false) }
    }}>Replace All</button></div>}
    <details className="search-details"><summary>Files to include / exclude</summary><input value={include} onChange={(event) => setInclude(event.target.value)} placeholder="Include, e.g. src/**" /><input value={exclude} onChange={(event) => setExclude(event.target.value)} placeholder="Exclude, comma-separated" /></details>
    <div className="result-summary">{loading ? 'Searching…' : `${results.length} result${results.length === 1 ? '' : 's'}`}</div>
    {error && <div className="inline-error">{error}</div>}
    {notice && <div className="search-notice">{notice}</div>}
    <div className="search-results">
      {results.map((result, index) => <button key={`${result.path}:${result.line}:${index}`} onClick={() => onOpen(result.path, result.line, result.column)}>
        <div><strong>{result.path.split('/').pop()}</strong><span> {result.line}:{result.column}</span></div>
        <div className="result-path">{result.path.replace(`${root}/`, '')}</div>
        <code>{result.preview}</code>
      </button>)}
    </div>
  </div>
}
