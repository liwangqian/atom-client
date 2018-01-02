import Dexie from "dexie";
import { resolveFromPubnub } from "../../lib/actions/pubnub-event";

Dexie.debug = true;
let db;

describe("resolveFromPubnub action creator", () => {
	const dispatch = jasmine.createSpy("dispatch spy").andCallFake(() => {
		const action = dispatch.mostRecentCall.args[0];
		if (action.apply) return action(dispatch, null, { db });
		else return action;
	});

	beforeEach(() => {
		db = new Dexie("test1");
		db.version(1).stores({
			records: "id",
			things: "id"
		});
	});

	afterEach(() => {
		Dexie.delete("test1");
	});

	describe("resolveFromPubnub", () => {
		describe("a single change", () => {
			it("updates the local cache with the changes provided and dispatches an update action", () => {
				const id = "id1";
				const changes = {
					id,
					name: "fizz",
					$set: { foo: "bar" },
					$unset: { oldProperty: true },
					$addToSet: {
						things: 2
					}
				};
				waitsForPromise(async () => {
					await db.records.add({ id, oldProperty: "ipsum", things: [1] });
					await resolveFromPubnub("records", changes)(dispatch, null, { db });

					expect(dispatch).toHaveBeenCalledWith({
						type: "RECORDS-UPDATE_FROM_PUBNUB",
						payload: { id, name: "fizz", foo: "bar", things: [1, 2] }
					});
				});
			});
		});

		describe("a collection of changes", () => {
			it("updates the local cache with all the changes provided and dispatches multiple update actions", () => {
				const id1 = "id1";
				const id2 = "id2";
				const changes = [
					{
						id: id1,
						name: "fizz"
					},
					{
						id: id2,
						name: "buzz"
					}
				];
				waitsForPromise(async () => {
					await db.records.bulkAdd([{ id: id1 }, { id: id2 }]);
					await resolveFromPubnub("records", changes)(dispatch, null, { db });

					expect(dispatch).toHaveBeenCalledWith({
						type: "RECORDS-UPDATE_FROM_PUBNUB",
						payload: { id: id1, name: "fizz" }
					});
					expect(dispatch).toHaveBeenCalledWith({
						type: "RECORDS-UPDATE_FROM_PUBNUB",
						payload: { id: id2, name: "buzz" }
					});
				});
			});
		});
	});
});