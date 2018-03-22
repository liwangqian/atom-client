import Raven from "raven-js";
import DeltaBuilder from "./DeltaBuilder";
import { structuredPatch } from "diff";
import { isValidLocation } from "../util/Marker";
import stripEof from "strip-eof";
import eol from "eol";

export default class MarkerLocationFinder {
	constructor({ gitRepo, accessToken, http, filePath, teamId, streamId }) {
		this._gitRepo = gitRepo;
		this._accessToken = accessToken;
		this._http = http;
		this._filePath = filePath;
		this._teamId = teamId;
		this._streamId = streamId;
	}

	async findUpdatedLocations(locations, filePath, oldText, newText) {
		oldText = stripEof(eol.auto(oldText));
		newText = stripEof(eol.auto(newText));

		const patch = structuredPatch(filePath, filePath, oldText, newText);
		const delta = new DeltaBuilder(patch).build();

		if (delta.edits.length) {
			return await this._calculateLocations(locations, delta.edits);
		} else {
			return locations;
		}
	}

	async findLocationsForCurrentCommit(markers) {
		const me = this;
		const filePath = me._filePath;
		const gitRepo = me._gitRepo;
		const currentCommit = await gitRepo.getCurrentCommit();
		const currentLocations = {};
		const markersByFirstCommit = {};

		for (const marker of markers) {
			const commitWhenCreated = marker.commitHashWhenCreated;
			const markersForCommit =
				markersByFirstCommit[commitWhenCreated] || (markersByFirstCommit[commitWhenCreated] = []);
			markersForCommit.push(marker);
		}

		for (const commitWhenCreated of Object.keys(markersByFirstCommit)) {
			const exists = await gitRepo.ensureCommitExists(commitWhenCreated);
			if (!exists) {
				continue;
			}

			const markersForCommit = markersByFirstCommit[commitWhenCreated];
			const locations = await this._getMarkerLocations(commitWhenCreated);
			const locationsToCalculate = {};
			for (const marker of markersForCommit) {
				const location = locations[marker._id];
				if (isValidLocation(location)) {
					locationsToCalculate[marker._id] = location;
				}
			}

			const delta = await gitRepo.getDeltaBetweenCommits(
				commitWhenCreated,
				currentCommit,
				filePath
			);
			if (delta.edits.length && Object.keys(locationsToCalculate).length) {
				const calculatedLocations = await this._calculateLocations(
					locationsToCalculate,
					delta.edits,
					commitWhenCreated,
					currentCommit
				);
				Object.assign(currentLocations, calculatedLocations);
			} else {
				Object.assign(currentLocations, locationsToCalculate);
			}
		}

		return currentLocations;
	}

	async findLocationsForUncommittedChanges(currentCommitLocations, bufferText) {
		const me = this;
		const filePath = me._filePath;
		const gitRepo = me._gitRepo;
		const currentCommit = await gitRepo.getCurrentCommit();
		const unsavedDelta = await gitRepo.getDeltaForUncommittedChanges(filePath, bufferText);
		const unsavedEdits = unsavedDelta.edits;

		let locations = { ...currentCommitLocations };

		if (unsavedEdits.length && Object.keys(locations).length) {
			const unsavedLocations = await this._calculateLocations(
				locations,
				unsavedEdits,
				currentCommit
			);
			locations = {
				...locations,
				...unsavedLocations
			};
		}

		return locations;
	}

	async backtrackLocationsAtCurrentCommit(dirtyLocations, bufferText) {
		const me = this;
		const filePath = me._filePath;
		const gitRepo = me._gitRepo;
		const currentCommit = await gitRepo.getCurrentCommit();
		const unsavedDelta = await gitRepo.getDeltaForUncommittedChanges(filePath, bufferText);
		const reverseEdits = me._reverseEdits(unsavedDelta.edits);

		if (reverseEdits.length) {
			const commitLocations = await this._calculateLocations(
				dirtyLocations,
				reverseEdits,
				currentCommit
			);
			return commitLocations;
		} else {
			return dirtyLocations;
		}
	}

	async _calculateLocations(locations, edits, originalCommitHash, newCommitHash) {
		let hasUncommittedLocation = false;
		for (const location of Object.values(locations)) {
			const meta = location[4] || {};
			if (meta.startWasDeleted || meta.endWasDeleted) {
				hasUncommittedLocation = true;
			}
		}
		try {
			const result = await this._http.put(
				"/calculate-locations?",
				{
					teamId: this._teamId,
					streamId: this._streamId,
					originalCommitHash: originalCommitHash,
					newCommitHash: hasUncommittedLocation ? undefined : newCommitHash,
					edits: edits,
					locations: locations
				},
				this._accessToken
			);
			return result.markerLocations.locations;
		} catch (error) {
			Raven.captureException(error, {
				logger: "MarkerLocationFinder._calculateLocations"
			});
			return {};
		}
	}

	_reverseEdits(edits) {
		const reversedEdits = [];

		// swap all add/del operations
		for (const edit of edits) {
			reversedEdits.push({
				delStart: edit.addStart,
				addStart: edit.delStart,
				delLength: edit.addLength,
				addLength: edit.delLength,
				dels: edit.adds,
				adds: edit.dels
			});
		}

		return reversedEdits;
	}

	async _getMarkerLocations(commitHash) {
		const { markerLocations } = await this._http.get(
			`/marker-locations?` +
				`teamId=${this._teamId}&` +
				`streamId=${this._streamId}&` +
				`commitHash=${commitHash}`,
			this._accessToken
		);
		const locations = markerLocations.locations || {};

		return locations;
	}
}
