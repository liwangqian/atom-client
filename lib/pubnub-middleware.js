import PubNubReceiver from "./pubnub-receiver";

export default store => {
	const receiver = new PubNubReceiver(store);

	return next => action => {
		const result = next(action);

		// Once users have been loaded from indexedDB, if continuing a session,
		// find current user and subscribe to team channels
		if (action.type === "BOOTSTRAP_USERS") {
			const { session, onboarding, users } = store.getState();
			if (onboarding.complete && session.accessToken) {
				const user = users[session.userId];
				const teamChannels = (user.teamIds || []).map(id => `team-${id}`);

				receiver.initialize(session.accessToken);
				receiver.subscribe([`user-${user.id}`, ...teamChannels]);
			}
		}
		// When starting a new session, subscribe to channels
		if (action.type === "INIT_SESSION") {
			const { user } = action.meta;
			const teamChannels = (user.teamIds || []).map(id => `team-${id}`);

			receiver.initialize(action.payload.accessToken);
			receiver.subscribe([`user-${user.id}`, ...teamChannels]);
		}

		return result;
	};
};