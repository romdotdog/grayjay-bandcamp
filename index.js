const API_URL = "https://bandcamp.com/api";
const id = sid => new PlatformID("Bandcamp", sid, config.id);
const isRegularBandcamp = url => /https:\/\/[a-z0-9-]+\.bandcamp\.com/.test(url);

const regularizeBandcamp = (url, identifier) => {
    if (isRegularBandcamp(url)) {
        return url;
    }
    return url + "#" + identifier;
}


let config = {};

/**
 * @param {SourceV8PluginConfig} config 
 */
source.enable = function (conf) {
    config = conf ?? {}
}

/** 
 * @param {Discover.Album} album
 * @returns {PlatformPlaylist}
 */
function albumToPlatformPlaylist(album) {
    const bandUrl = album.band_url.replace("?from=discover_page", "");
    const itemUrl = album.item_url.replace("?from=discover_page", "");
    return new PlatformPlaylist({
        id: id(album.id.toString()),
        name: album.title,
        thumbnail: `https://f4.bcbits.com/img/a${album.item_image_id}_2.jpg`,
        author: new PlatformAuthorLink(id(album.band_id.toString()), album.band_name, regularizeBandcamp(bandUrl, "bandcampBand"), `https://f4.bcbits.com/img/${album.band_bio_image_id}_9.jpg`),
        videoCount: album.track_count,
        url: regularizeBandcamp(itemUrl, "bandcampAlbum"),
    });
}

class QueryPager extends VideoPager {
    constructor(overrides) {
        const context = Object.assign({
            category_id: 0,
            tag_norm_names: [],
            geoname_id: 0,
            slice: "top",
            cursor: "*",
            size: 20,
            include_result_types: ["a"]
        }, overrides);

        const { results, hasMore } = QueryPager.fetch(context);
        super(results, hasMore, context);
    }

    static fetch(context) {
        const res = http.POST(`${API_URL}/discover/1/discover_web`, JSON.stringify(context), {}, false);

        /** @type {Discover.SearchResults} */
        const json = JSON.parse(res.body);

        context.cursor = json.cursor;

        return {
            results: json.results.map(albumToPlatformPlaylist),
            hasMore: json.batch_result_count >= context.size
        };
    }

    nextPage() {
        const { results, hasMore } = QueryPager.fetch(this.context);
        this.results = results;
        this.hasMore = hasMore;
        return this;
    }
}

source.getHome = function (page) {
    return new QueryPager({})
}

source.isPlaylistUrl = function (url) {
    return /^https:\/\/[a-z0-9-]+\.bandcamp\.com\/album\/[a-z0-9-]+\/?$/.test(url)|| /#bandcampAlbum$/.test(url);
}

function getPageJSON(html) {
    const scriptMatch = html.match(/<script type="application\/ld\+json">\n\s*(.+)/m);
    if (scriptMatch) {
        return JSON.parse(scriptMatch[1]);
    }
}

const findProperty = (o, k) => o.additionalProperty.find(p => p.name === k).value;
source.getPlaylist = function (url) {
    const res = http.GET(url, {}, false);

    /** @type {MusicAlbum.Album | undefined} */
    const album = getPageJSON(res.body);
    if (album) {
        const albumRelease = album.albumRelease[0];
        const publisher = album.publisher;

        const thumbnailUrl = `https://f4.bcbits.com/img/a${findProperty(albumRelease, "art_id")}_2.jpg`;
        const author = new PlatformAuthorLink(id(findProperty(publisher, "band_id").toString()), publisher.name, regularizeBandcamp(publisher["@id"], "bandcampBand"), `https://f4.bcbits.com/img/${findProperty(publisher, "image_id")}_9.jpg`);
        const datetime = Math.trunc(new Date(album.datePublished).getTime() / 1000);

        return new PlatformPlaylistDetails({
            id: id(findProperty(albumRelease, "item_id").toString()),
            name: album.name,
            thumbnail: thumbnailUrl,
            author,
            videoCount: album.numTracks,
            contents: new VideoPager(album.track.itemListElement.map(item => {
                const track = item.item;
                return new PlatformVideo({
                    id: id(findProperty(track, "track_id").toString()),
                    name: track.duration ? track.name : `${track.name} [UNRELEASED]`,
                    thumbnails: new Thumbnails([new Thumbnail(thumbnailUrl, 0)]),
                    author,
                    datetime,
                    duration: track.duration ? parseDuration(track.duration) : undefined,
                    url: regularizeBandcamp(track["@id"], "bandcampTrack"),
                });
            }), false),
            url: regularizeBandcamp(album["@id"], "bandcampAlbum"),
        });
    }
    return [];
}

function getPageAttribute(html, tag) {
    const scriptSrc = html.match(new RegExp(`^.+${tag}=.+$`, "m"));
    if (scriptSrc) {
        const script = domParser.parseFromString(scriptSrc[0]).firstChild.firstChild.firstChild;
        return JSON.parse(script.getAttribute(tag));
    }
}

source.isContentDetailsUrl = function (url) {
    return /^https:\/\/[a-z0-9-]+\.bandcamp\.com\/track\/[a-z0-9-]+\/?$/.test(url)|| /#bandcampTrack$/.test(url);
}

source.getContentDetails = function (url) {
    const res = http.GET(url, {}, false);
    const track = getPageJSON(res.body);
    const tralbum = getPageAttribute(res.body, "data-tralbum");

    if (track && tralbum) {
        const publisher = track.publisher;

        const thumbnailUrl = `https://f4.bcbits.com/img/a${findProperty(track, "art_id")}_2.jpg`;
        const author = new PlatformAuthorLink(id(findProperty(publisher, "band_id").toString()), publisher.name, regularizeBandcamp(publisher["@id"], "bandcampBand"), `https://f4.bcbits.com/img/${findProperty(publisher, "image_id")}_9.jpg`);
        const datetime = Math.trunc(new Date(track.datePublished).getTime() / 1000);

        const trackinfo = tralbum.trackinfo[0];
        const sources = Object.entries(trackinfo.file).map(([format, url]) => new AudioUrlSource({
            container: "audio/mpeg",
            bitrate: parseInt(format.split("-")[1]) * 1000,
            name: format,
            duration: Math.trunc(trackinfo.duration),
            url,
            language: "Unknown"
        }));

        let description = undefined;

        const albumId = tralbum.current.album_id;
        if (albumId) {            
            const res = http.GET(`${API_URL}/mobile/25/tralbum_details?tralbum_type=a&tralbum_id=${albumId}&band_id=${tralbum.current.band_id}`, {}, false);
            const details = JSON.parse(res.body);

            description = `from the album ${details.title}`;
            
            if (details.about) {
                description += `\n\n${details.about}`;
            }
        }

        return new PlatformVideoDetails({
            id: id(findProperty(track, "track_id").toString()),
            name: track.name,
            thumbnails: new Thumbnails([new Thumbnail(thumbnailUrl, 0)]),
            author,
            datetime,
            description,
            video: new UnMuxVideoSourceDescriptor([], sources),
            duration: track.duration ? parseDuration(track.duration) : undefined,
            url: regularizeBandcamp(track["@id"], "bandcampTrack"),
        });
    }
}

source.isChannelUrl = function (url) {
    /**
     * @param url: string
     * @returns: boolean
     */

    return /^https:\/\/[a-z0-9-]+\.bandcamp\.com\/?(?:music\/?)?$/.test(url) || /#bandcampBand$/.test(url);
}

function getMusicPath(url) {
    return new URL("/music", url).href;
}

source.getChannel = function (url) {
    url = getMusicPath(url);
    const res = http.GET(url, {}, false);
    const band = getPageAttribute(res.body, "data-band");
    if (band) {
        const document = domParser.parseFromString(res.body);

        return new PlatformChannel({
            id: id(band.id.toString()),
            name: band.name,
            url: regularizeBandcamp(band.url, "bandcampBand"),
            thumbnail: document.querySelector("div.artists-bio-pic img")?.getAttribute("src"),
            banner: document.querySelector("div.desktop-header img")?.getAttribute("src"),
            description: document.getElementById("bio-text")?.text,
            links: Object.fromEntries(document.querySelectorAll("#band-links a").map(a => [a.text, a.getAttribute("href")])),
        });
    }
}

class DiscographyPager extends VideoPager {
    constructor(url) {
        url = getMusicPath(url);
        const res = http.GET(url, {}, false);
        const band = getPageAttribute(res.body, "data-band");

        let results = [];
        if (band) {
            const document = domParser.parseFromString(res.body);
            const bandUrl = band.url;
            const author = new PlatformAuthorLink(id(band.id.toString()), band.name, regularizeBandcamp(bandUrl, "bandcampBand"), document.querySelector("div.artists-bio-pic img")?.getAttribute("src"));
            const getArtSrc = img => img.getAttribute("data-original") || img.getAttribute("src");

            results = document.querySelectorAll(`li[data-item-id^="album-"]`).map(album => new PlatformPlaylist({
                id: id(album.getAttribute("data-item-id").substring(6)),
                name: album.querySelector("p.title").text,
                thumbnail: getArtSrc(album.querySelector("img")),
                author,
                url: regularizeBandcamp(new URL(album.querySelector("a").getAttribute("href"), bandUrl).href, "bandcampAlbum"),
            }));

            super(results, false, {});
        }
    }

    nextPage() {
        return this;
    }
}


source.getChannelContents = function (url, type, order, filters, continuationToken) {
    return new DiscographyPager(url);
}

function commentToPlatformComment(comment, contextUrl) {
    let message = comment.why;
    if (message.fav_track_title) {
        message += `Favorite track: ${message.fav_track_title}`;
    }

    return new Comment({
        contextUrl,
        author: new PlatformAuthorLink(
            id(comment.fan_id.toString()),
            comment.name,
            comment.url,
            `https://f4.bcbits.com/img/${comment.image_id}_50.jpg`
        ),
        message,
        date: Math.trunc(new Date(comment.mod_date).getTime() / 1000),
        context: null,
    })
}

class AlbumCommentPager extends CommentPager {
    constructor(overrides, contextUrl) {
        const context = Object.assign({
            tralbum_type: "a",
            // tralbum_id: <number>,
            count: 15,
            exclude_fan_ids: []
        }, overrides);

        const { results, hasMore } = AlbumCommentPager.fetch(context, contextUrl);
        super(results, hasMore, context);
        this.contextUrl = contextUrl;
    }

    static fetch(context, contextUrl) {
        const res = http.POST(`${API_URL}/tralbumcollectors/2/reviews`, JSON.stringify(context), {}, false);
        const json = JSON.parse(res.body);

        const results = json.results;
        context.token = results[results.length - 1]?.token;

        return {
            results: json.results.map(c => commentToPlatformComment(c, contextUrl)),
            hasMore: json.more_available
        };
    }

    nextPage() {
        const { results, hasMore } = AlbumCommentPager.fetch(this.context, this.contextUrl);
        this.results = results;
        this.hasMore = hasMore;
        return this;
    }
}

source.getComments = function (url) {
    const res = http.GET(url, {}, false);
    const tralbum = getPageAttribute(res.body, "data-tralbum");

    const albumId = tralbum?.current?.album_id;
    if (albumId) {
        return new AlbumCommentPager({ tralbum_id: albumId }, regularizeBandcamp(tralbum.url, "bandcampAlbum"));
    }    
}

function search(overrides) {
    const payload = Object.assign({
        fan_id: null,
        full_page: false,
        search_filter: ""
    }, overrides);

    const res = http.POST(`${API_URL}/bcsearch_public_api/1/autocomplete_elastic`, JSON.stringify(payload), {}, false);
    return JSON.parse(res.body);
}

function condenseSearchResult(r) {
    switch (r.type) {
        case "b": // band
            return r.name;
        case "a": // album
            if (r.name.startsWith(`${r.band_name} - `)) return r.name;
            return `${r.band_name} - ${r.name}`;
        case "t": // track
            if (r.name.startsWith(`${r.band_name} - `)) return r.name;
            return `${r.band_name} - ${r.name}`;
    }
    throw new Error(`unknown search result type ${r.type}`);
}

source.searchSuggestions = function (query) {
    return search({ search_text: query }).auto.results.map(condenseSearchResult);
}

source.getSearchCapabilities = function () {
    return {
        types: [Type.Feed.Mixed],
        sorts: [],
        filters: []
    };
}

source.search = function (query) {
    const { results } = search({ search_text: query, search_filter: "a" }).auto;
    const albums = results.map(album => new PlatformPlaylist({
        id: id(album.id.toString()),
        name: album.name,
        thumbnail: `https://f4.bcbits.com/img/a${album.art_id}_3.jpg`,
        author: new PlatformAuthorLink(id(album.band_id.toString()), album.band_name, regularizeBandcamp(album.item_url_root, "bandcampBand")),
        url: regularizeBandcamp(album.item_url_path, "bandcampAlbum"),
    }));
    return new VideoPager(albums, false, {});
}

source.getSearchChannelContentsCapabilities = function () {
    return {
        types: [Type.Feed.Mixed],
        sorts: [Type.Order.Chronological],
        filters: []
    };
}

source.searchChannels = function (query) {
    const { results } = search({ search_text: query, search_filter: "b" }).auto;
    const bands = results.map(band => new PlatformChannel({
        id: id(band.id.toString()),
        name: band.name,
        url: regularizeBandcamp(band.item_url_root, "bandcampBand"),
        thumbnail: band.img,
        description: band.location,
    }));
    return new ChannelPager(bands, false, {});
}

// https://gist.github.com/adriengibrat/e0b6d16cdd8c584392d8
// had to modify a bit
let durationRegex = /^P(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/;
function parseDuration(duration) {
    let seconds;
    duration && duration.replace(durationRegex, (_, ...units) => {
        // parse number for each unit
        let [hour, minute, second] = units.map((num) => parseInt(num, 10) || 0);
        seconds = hour * 3600 + minute * 60 + second;
    });
    // no regexp match
    if (!seconds) throw new Error(`Invalid duration "${duration}"`);
    return seconds;
}