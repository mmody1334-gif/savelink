import { describe, expect, it } from 'vitest'
import {
  parseAkwamSearchResults,
  parseAkwamDetails,
  searchMovies,
  buildSmartQueries,
  scoreMovieItem,
} from '../src/movies'

describe('movies engine', () => {
  it('expands queries with smart aliases and removes filler words', () => {
    const q1 = buildSmartQueries('marvel endgame')
    expect(q1).toContain('marvel endgame')
    expect(q1).toContain('Avengers Endgame')
    expect(q1).toContain('endgame')

    const q2 = buildSmartQueries('ثانوس')
    expect(q2).toContain('Avengers Endgame')

    const q3 = buildSmartQueries('فيلم درويلة')
    expect(q3).toContain('درويلة')
  })

  it('ranks relevant movie titles higher based on matching terms', () => {
    const terms = new Set(['endgame', 'avengers'])
    const item1 = { id: '1', title: 'Avengers: Endgame', url: '', kind: 'movie' as const }
    const item2 = { id: '2', title: 'Marvel Zombies', url: '', kind: 'series' as const }
    const item3 = { id: '3', title: 'The Endgame', url: '', kind: 'series' as const }

    const s1 = scoreMovieItem(item1, terms)
    const s2 = scoreMovieItem(item2, terms)
    const s3 = scoreMovieItem(item3, terms)

    expect(s1).toBeGreaterThan(s3)
    expect(s3).toBeGreaterThan(s2)
  })
  it('parses movie and series search results from Akwam HTML', () => {
    const sampleHtml = `
      <div class="entry-box">
        <div class="labels d-flex">
          <span class="label rating"><i class="icon-star mr-2"></i>7.5</span>
          <span class="label quality">WEB-DL</span>
        </div>
        <div class="entry-image">
          <a href="https://akwam.ss/movie/10342/derwila-1" class="box">
            <picture>
              <img src="https://img.downet.net/thumb/178x260/placeholder.png" data-src="https://img.downet.net/thumb/178x260/uploads/WbVAI.jpg" alt="درويلة"/>
            </picture>
          </a>
        </div>
        <div class="entry-body">
          <h3 class="entry-title font-size-14 m-0"><a href="https://akwam.ss/movie/10342/derwila-1">فيلم درويلة</a></h3>
          <span class="badge badge-pill badge-secondary ml-1">2024</span>
        </div>
      </div>
      <div class="entry-box">
        <div class="labels d-flex">
          <span class="label rating"><i class="icon-star mr-2"></i>8.2</span>
        </div>
        <div class="entry-image">
          <a href="https://akwam.ss/series/4932/welad-alshams-1" class="box">
            <picture>
              <img data-src="https://img.downet.net/thumb/178x260/uploads/5fuil.jpg" alt="ولاد الشمس"/>
            </picture>
          </a>
        </div>
        <div class="entry-body">
          <h3 class="entry-title font-size-14 m-0"><a href="https://akwam.ss/series/4932/welad-alshams-1">مسلسل ولاد الشمس</a></h3>
          <span class="badge badge-pill badge-secondary ml-1">2024</span>
        </div>
      </div>
    `

    const results = parseAkwamSearchResults(sampleHtml)
    expect(results.length).toBe(2)

    expect(results[0].id).toBe('movie:10342')
    expect(results[0].title).toBe('فيلم درويلة')
    expect(results[0].kind).toBe('movie')
    expect(results[0].year).toBe('2024')
    expect(results[0].rating).toBe('7.5')
    expect(results[0].poster).toBe('https://img.downet.net/thumb/178x260/uploads/WbVAI.jpg')

    expect(results[1].id).toBe('series:4932')
    expect(results[1].title).toBe('مسلسل ولاد الشمس')
    expect(results[1].kind).toBe('series')
    expect(results[1].year).toBe('2024')
  })

  it('parses movie details with qualities and file sizes', () => {
    const movieHtml = `
      <h1 class="entry-title">فيلم درويلة</h1>
      <span class="text-white">السنة : 2024</span>
      <p class="text-white font-size-18">تدور الأحداث حول شاب يخرج من السجن ليواجه عصابة.</p>
      <div class="widget-body">
        <h2>قصة الفيلم</h2>
        <div class="widget-body">تدور الأحداث حول شاب يخرج من السجن ليواجه عصابة.</div>
      </div>
      <div class="download-item">
        <span>1080p</span>
        <a href="https://akwam.ss/watch/166906/10342/derwila-1">مشاهدة</a>
        <a href="https://akwam.ss/download/166906/10342/derwila-1">تحميل 1.2 GB</a>
      </div>
      <div class="download-item">
        <span>720p</span>
        <a href="https://akwam.ss/watch/166907/10342/derwila-1">مشاهدة</a>
        <a href="https://akwam.ss/download/166907/10342/derwila-1">تحميل 650 MB</a>
      </div>
    `

    const details = parseAkwamDetails(movieHtml, 'https://akwam.ss/movie/10342/derwila-1')
    expect(details.id).toBe('movie:10342')
    expect(details.title).toBe('فيلم درويلة')
    expect(details.kind).toBe('movie')
    expect(details.year).toBe('2024')
    expect(details.story).toContain('تدور الأحداث حول شاب')
    expect(details.qualities.length).toBe(2)
    expect(details.qualities[0].quality).toBe('1080P')
    expect(details.qualities[0].size).toBe('1.2 GB')
    expect(details.qualities[1].quality).toBe('720P')
    expect(details.qualities[1].size).toBe('650 MB')
  })

  it('parses series details with episodes', () => {
    const seriesHtml = `
      <h1 class="entry-title">مسلسل ولاد الشمس</h1>
      <a href="https://akwam.ss/episode/87483/welad-alshams/الحلقة-15">حلقة 15 : مسلسل ولاد الشمس</a>
      <a href="https://akwam.ss/episode/87461/welad-alshams/الحلقة-14">حلقة 14 : مسلسل ولاد الشمس</a>
      <a href="https://akwam.ss/episode/87395/welad-alshams/الحلقة-12">حلقة 12 : مسلسل ولاد الشمس</a>
    `

    const details = parseAkwamDetails(seriesHtml, 'https://akwam.ss/series/4932/welad-alshams')
    expect(details.kind).toBe('series')
    expect(details.episodes.length).toBe(3)
    // Should be sorted ascending by episode number
    expect(details.episodes[0].number).toBe(12)
    expect(details.episodes[1].number).toBe(14)
    expect(details.episodes[2].number).toBe(15)
  })

  it('returns empty array on empty query', async () => {
    const res = await searchMovies('   ')
    expect(res).toEqual([])
  })
})
