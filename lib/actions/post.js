import Raven from "raven-js";
import _ from "underscore-plus";
import { upsert } from "../local-cache";
import { normalize } from "./utils";
import * as pubnubActions from "./pubnub-event";
import { fetchMarkersAndLocations } from "./marker-location";
import { saveStream } from "./stream";
import { saveMarkers } from "./marker";
import { saveMarkerLocations } from "./marker-location";
import { getStreamForRepoAndFile } from "../reducers/streams";
import MarkerLocationFinder from "../git/MarkerLocationFinder";
import { open as openRepo } from "../git/GitRepo";

const createTempId = (() => {
	let count = 0;
	return () => String(count++);
})();

const pendingPostFailed = post => ({ type: "PENDING_POST_FAILED", payload: post });

const fetchLatest = (mostRecentPost, streamId, teamId) => async (dispatch, getState, { http }) => {
	const { context } = getState();
	let url = `/posts?teamId=${teamId}&streamId=${streamId}&withMarkers`;
	if (context.currentCommit) url += `&commitHash=${context.currentCommit}`;
	if (mostRecentPost) url += `&gt=${mostRecentPost.id}`;
	const { posts, markers, markerLocations, more } = await http.get(
		url,
		getState().session.accessToken
	);
	const normalizedMarkers = normalize(markers || []);
	dispatch(saveMarkers(normalizedMarkers));
	if (markerLocations) dispatch(saveMarkerLocations(markerLocations));
	const normalizedPosts = normalize(posts);
	const save = dispatch(savePostsForStream(streamId, normalizedPosts));
	// only take the first page if no mostRecentPost
	if (more && mostRecentPost) return dispatch(fetchLatest(normalizedPosts[0].id, streamId, teamId));
	else return save;
};

export const fetchLatestPosts = streams => (dispatch, getState, { db, http }) => {
	return Promise.all(
		streams.map(async stream => {
			const cachedPosts = await db.posts.where({ streamId: stream.id }).sortBy("seqNum");
			const mostRecentCachedPost = cachedPosts[cachedPosts.length - 1];
			return dispatch(fetchLatest(mostRecentCachedPost, stream.id, stream.teamId));
		})
	);
};

// FIXME: tech debt. these next two functions are only for use when starting with a clean local cache until
// the streams support lazy loading and infinite lists
const fetchOlderPosts = (mostRecentPost, streamId, teamId) => async (
	dispatch,
	getState,
	{ http }
) => {
	const { context, session } = getState();
	let url = `/posts?teamId=${teamId}&streamId=${streamId}&withMarkers&commitHash=${
		context.currentCommit
	}`;
	if (mostRecentPost) url += `&lt=${mostRecentPost.id}`;
	const { posts, markers, markerLocations, more } = await http.get(url, session.accessToken);
	const normalizedMarkers = normalize(markers || []);
	dispatch(saveMarkers(normalizedMarkers));
	if (markerLocations) dispatch(saveMarkerLocations(markerLocations));
	const normalizedPosts = normalize(posts);
	const save = dispatch(savePostsForStream(streamId, normalizedPosts));
	if (more)
		return dispatch(fetchOlderPosts(normalizedPosts[normalizedPosts.length - 1], streamId, teamId));
	else return save;
};

export const fetchAllPosts = streams => (dispatch, getState, {}) => {
	return Promise.all(
		streams.map(async stream => {
			dispatch(fetchOlderPosts(null, stream.id, stream.teamId));
		})
	);
};

export const fetchLatestForCurrentStream = () => async (dispatch, getState, { http }) => {
	const { context, session, streams } = getState();

	if (context.currentFile) {
		const currentStream = getStreamForRepoAndFile(
			streams,
			context.currentRepoId,
			context.currentFile
		);
		if (currentStream) return dispatch(fetchLatestPosts([currentStream]));
		else {
			const url = `/posts?teamId=${context.currentTeamId}&repoId=${context.currentRepoId}&path=${
				context.currentFile
			}`;
			try {
				const data = await http.get(url, session.accessToken);
				const stream = normalize(data.stream);
				dispatch(saveStream(stream));
				const posts = normalize(data.posts);
				const save = await dispatch(savePosts(posts));
				if (posts.length > 0 && data.more)
					return dispatch(fetchLatest(_.sortBy(posts, "seqNum")[0], stream.id, stream.teamId));
				else return save;
			} catch (error) {
				if (http.isApiRequestError(error) && error.data.code === "RAPI-1003") {
					/* No stream for this file */
				} else {
					console.error(`Unexpected error fetching latest posts for ${context.currentFile}`, error);
					Raven.captureException(error, {
						logger: "actions/post"
					});
				}
			}
		}
	}
};

export const fetchPosts = ({ streamId, teamId }) => async (dispatch, getState, { db, http }) => {
	const { session } = getState();
	const { posts } = await http.get(
		`/posts?teamId=${teamId}&streamId=${streamId}`,
		session.accessToken
	);
	dispatch(savePostsForStream(streamId, normalize(posts)));
	return dispatch(fetchMarkersAndLocations({ streamId, teamId }));
};

export const savePost = attributes => (dispatch, getState, { db }) => {
	return upsert(db, "posts", attributes).then(post =>
		dispatch({
			type: "ADD_POST",
			payload: post
		})
	);
};

export const savePosts = attributes => (dispatch, getState, { db }) => {
	return upsert(db, "posts", attributes).then(posts =>
		dispatch({
			type: "ADD_POSTS",
			payload: posts
		})
	);
};

export const savePostsForStream = (streamId, attributes) => (dispatch, getState, { db }) => {
	return upsert(db, "posts", attributes).then(posts =>
		dispatch({
			type: "ADD_POSTS_FOR_STREAM",
			payload: { streamId, posts }
		})
	);
};

export const savePendingPost = attributes => (dispatch, getState, { db }) => {
	return upsert(db, "posts", { ...attributes, pending: true }).then(post => {
		dispatch({
			type: "ADD_PENDING_POST",
			payload: post
		});
	});
};

export const createPost = (
	streamId,
	parentPostId,
	text,
	codeBlocks,
	mentions,
	bufferText
) => async (dispatch, getState, { http }) => {
	const state = getState();
	const { session, context } = state;
	const pendingId = createTempId();

	codeBlocks = await backtrackMarkerLocations(codeBlocks, bufferText, streamId, state, http);
	const post = {
		id: pendingId,
		teamId: context.currentTeamId,
		timestamp: new Date().getTime(),
		creatorId: session.userId,
		parentPostId: parentPostId,
		codeBlocks: codeBlocks,
		commitHashWhenPosted: context.currentCommit,
		mentionedUserIds: mentions && mentions.length ? mentions : null,
		text
	};

	if (streamId) {
		post.streamId = streamId;
	} else
		post.stream = {
			teamId: context.currentTeamId,
			type: "file",
			file: context.currentFile,
			repoId: context.currentRepoId
		};

	dispatch(savePendingPost({ ...post }));

	try {
		const data = await http.post("/posts", post, session.accessToken);
		if (!streamId) dispatch(saveStream(normalize(data.stream)));
	} catch (error) {
		Raven.captureException(error, {
			logger: "actions/post"
		});
		// TODO: different types of errors?
		dispatch(rejectPendingPost(pendingId, { ...post, error: true }));
	}
};

const backtrackMarkerLocations = async (codeBlocks, bufferText, streamId, state, http) => {
	const { context, repoAttributes, session } = state;
	const gitRepo = await openRepo(repoAttributes.workingDirectory);
	const dirtyLocations = codeBlocks.map(codeBlock => codeBlock.location);
	const locationFinder = new MarkerLocationFinder({
		filePath: context.currentFile,
		gitRepo,
		http,
		accessToken: session.accessToken,
		teamId: context.currentTeamId,
		streamId
	});

	const backtrackedLocations = await locationFinder.backtrackLocationsAtCurrentCommit(
		dirtyLocations,
		bufferText
	);
	const backtrackedCodeBlocks = [];

	for (let i = 0; i < codeBlocks.length; i++) {
		backtrackedCodeBlocks.push({
			...codeBlocks[i],
			location: backtrackedLocations[i]
		});
	}

	return backtrackedCodeBlocks;
};

export const resolveFromPubnub = (post, isHistory) => async (dispatch, getState, { db }) => {
	Raven.captureBreadcrumb({
		message: "Attempting to resolve a post from pubnub",
		category: "action",
		data: { post, isHistory }
	});
	const { session } = getState();
	if (post.creatorId === session.userId) {
		Raven.captureBreadcrumb({
			message: "post from pubnub belongs to current user",
			category: "action"
		});
		const { creatorId, teamId, streamId, commitHashWhenPosted, text } = post;

		const searchAttributes = {
			creatorId,
			teamId,
			streamId,
			text,
			commitHashWhenPosted: commitHashWhenPosted || "" // posts from email won't have commit hashes
		};
		if (post.parentPostId) searchAttributes.parentPostId = post.parentPostId;

		const pendingPost = await db.posts
			.where(searchAttributes)
			.filter(p => p.pending)
			.first();
		if (pendingPost) {
			dispatch(resolvePendingPost(pendingPost.id, post));
		} else {
			Raven.captureBreadcrumb({
				message: "post from pubnub does not match a pending post",
				category: "action",
				data: { pendingPost, searchAttributes }
			});
			dispatch(pubnubActions.resolveFromPubnub("posts", post, isHistory));
		}
	} else {
		Raven.captureBreadcrumb({
			message: "post from pubnub does not belong to current user",
			category: "action"
		});
		dispatch(pubnubActions.resolveFromPubnub("posts", post, isHistory));
	}
};

const resolvePendingPost = (id, resolvedPost) => (dispatch, getState, { db }) => {
	return db
		.transaction("rw", db.posts, () => {
			db.posts.delete(id);
			upsert(db, "posts", resolvedPost);
		})
		.then(() =>
			dispatch({
				type: "RESOLVE_PENDING_POST",
				payload: {
					pendingId: id,
					post: resolvedPost
				}
			})
		);
};

export const rejectPendingPost = pendingId => (dispatch, getState, { db }) => {
	return upsert(db, "posts", { id: pendingId, error: true }).then(post =>
		dispatch(pendingPostFailed(post))
	);
};

export const cancelPost = pendingId => async (dispatch, getState, { db }) => {
	return db.posts
		.delete(pendingId)
		.then(() => dispatch({ type: "CANCEL_PENDING_POST", payload: pendingId }));
};

export const retryPost = pendingId => async (dispatch, getState, { db, http }) => {
	const pendingPost = await db.posts.get(pendingId);
	return http
		.post("/posts", pendingPost, getState().session.accessToken)
		.then(data =>
			dispatch(
				resolvePendingPost(pendingId, {
					post: normalize(data.post),
					markers: normalize(data.markers),
					markerLocations: data.markerLocations,
					stream: pendingPost.stream ? normalize(data.stream) : null
				})
			)
		)
		.catch(error => {
			Raven.captureBreadcrumb({
				message: "Failed to retry a post",
				category: "action",
				data: { error, pendingPost },
				level: "error"
			});
			dispatch(pendingPostFailed(pendingPost));
		});
};

export const editPost = (postId, text, mentions) => async (dispatch, getState, { http }) => {
	const { session, context } = getState();

	const delta = {
		text,
		mentionedUserIds: mentions
	};

	try {
		const data = await http.put("/posts/" + postId, delta, session.accessToken);
	} catch (error) {
		// TODO: different types of errors?
		dispatch(rejectEditPost(postId, { ...delta, error: true }));
	}
};

export const deletePost = postId => async (dispatch, getState, { http }) => {
	const { session, context } = getState();
	try {
		const data = await http.deactivate("/posts/" + postId, {}, session.accessToken);
	} catch (error) {
		// TODO: different types of errors?
		dispatch(rejectDeletePost(postId, { ...delta, error: true }));
	}
};
