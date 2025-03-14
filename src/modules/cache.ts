import * as fs from "fs";
import { api, id, utils, config } from "../index";

export namespace cache {
  export enum CacheErrorMessages {
    locked = "Object locked",
    notFound = "Object not found",
    expired = "Object expired",
  }

  export interface CacheObject {
    key: string;
    value: any;
    expireTimestamp: number;
    createdAt: number;
    lastReadAt: number;
    readAt?: number;
  }

  export interface CacheOptions {
    expireTimeMS?: number;
    retry?: boolean | number;
  }

  export const redisPrefix: string = config.general.cachePrefix;
  export const lockPrefix: string = config.general.lockPrefix;
  export const lockDuration: number = config.general.lockDuration;
  export const scanCount: number = config.redis.scanCount || 1000;
  export const lockRetry: number = 100;

  export function client() {
    if (api.redis.clients && api.redis.clients.client) {
      return api.redis.clients.client;
    } else {
      throw new Error("redis not connected, cache cannot be used");
    }
  }

  let lockNameOverride: string;
  export function lockName() {
    if (lockNameOverride) return lockNameOverride;
    return id;
  }

  export function overrideLockName(name: string) {
    lockNameOverride = name;
  }

  /**
   * A generic method to find all keys which match a pattern.
   * @pattern likely has a * at the end of the string.  Other arguments are for recursion and not required.
   */
  export async function getKeys(
    pattern: string,
    count: number = scanCount,
    keysAry: string[] = [],
    cursor = 0
  ): Promise<Array<string>> {
    // return client().keys(redisPrefix + "*");

    const [newCursor, matches] = await client().scan(
      cursor,
      "match",
      pattern,
      "count",
      count
    );

    if (matches && matches.length > 0) keysAry = keysAry.concat(matches);
    if (newCursor === "0") return keysAry;
    return cache.getKeys(pattern, count, keysAry, parseInt(newCursor));
  }

  /**
   * Returns all the keys in redis which are under this Actionhero namespace.  Potentially very slow.
   */
  export async function keys(optionalScopePrefix = ""): Promise<Array<string>> {
    // return client().keys(redisPrefix + "*");
    return getKeys(redisPrefix + optionalScopePrefix + "*");
  }

  /**
   * Returns all the locks in redis which are under this Actionhero namespace.  Potentially slow.
   */
  export async function locks(
    optionalScopePrefix = ""
  ): Promise<Array<string>> {
    // return client().keys(lockPrefix + "*");
    return getKeys(lockPrefix + optionalScopePrefix + "*");
  }

  /**
   * Returns the number of keys in redis which are under this Actionhero namespace.  Potentially very slow.
   */
  export async function size(pattern = redisPrefix + "*") {
    let length = 0;
    const keys = await cache.getKeys(pattern);
    if (keys) length = keys.length;
    return length;
  }

  /**
   * Removes all keys in redis which are under this Actionhero namespace.  Potentially very slow.
   * Returns the deleted keys.
   */
  export async function clear(pattern = redisPrefix + "*") {
    const keys = await cache.getKeys(pattern);

    const pipelineArgs: Array<[string, string]> = [];
    keys.forEach((key: string) => {
      pipelineArgs.push(["del", key]);
    });

    await client().pipeline(pipelineArgs).exec();

    return keys;
  }

  /**
   * Write the current concents of redis (only the keys in Actionhero's namespace) to a file.
   */
  export async function dumpWrite(file: string) {
    const data: Record<string, any> = {};
    const jobs: Array<Promise<void>> = [];
    const keys = await cache.keys();

    keys.forEach((key: string) => {
      jobs.push(
        client()
          .get(key)
          .then((content) => {
            data[key] = content;
          })
      );
    });

    await Promise.all(jobs);

    fs.writeFileSync(file, JSON.stringify(data));
    return keys.length;
  }

  /**
   * Load in contents for redis (and api.cache) saved to a file
   * Warning! Any existing keys in redis (under this Actionhero namespace) will be removed.
   */
  export async function dumpRead(file: string) {
    const jobs: Array<Promise<void>> = [];
    await cache.clear();
    const fileData = fs.readFileSync(file).toString();
    const data = JSON.parse(fileData);
    const count = Object.keys(data).length;

    const saveDumpedElement = async (key: string, content: any) => {
      const parsedContent = JSON.parse(content);
      await client().set(key, content);
      if (parsedContent.expireTimestamp) {
        const expireTimeSeconds = Math.ceil(
          (parsedContent.expireTimestamp - new Date().getTime()) / 1000
        );
        await client().expire(key, expireTimeSeconds);
      }
    };

    Object.keys(data).forEach((key) => {
      const content = data[key];
      jobs.push(saveDumpedElement(key, content));
    });

    await Promise.all(jobs);
    return count;
  }

  /**
   * Load an item from the cache.  Will throw an error if the item named by `key` cannot be found.
   * Automatically handles `api.cache.redisPrefix`
   */
  export async function load(
    key: string,
    options: CacheOptions = {}
  ): Promise<CacheObject> {
    let cacheObj: CacheObject;

    let lockOk = await cache.checkLock(key, options.retry);
    if (lockOk !== true) throw new Error(CacheErrorMessages.locked);

    let cachedStringifiedObjet = await client().get(`${redisPrefix}${key}`);
    try {
      cacheObj = JSON.parse(cachedStringifiedObjet);
    } catch (e) {}

    if (!cacheObj) throw new Error(CacheErrorMessages.notFound);

    if (
      cacheObj.expireTimestamp &&
      cacheObj.expireTimestamp < new Date().getTime()
    ) {
      throw new Error(CacheErrorMessages.expired);
    }

    const lastReadAt = cacheObj.readAt;
    let expireTimeSeconds: number;
    cacheObj.readAt = new Date().getTime();

    if (cacheObj.expireTimestamp) {
      if (options.expireTimeMS) {
        cacheObj.expireTimestamp = new Date().getTime() + options.expireTimeMS;
        expireTimeSeconds = Math.ceil(options.expireTimeMS / 1000);
      } else {
        expireTimeSeconds = Math.floor(
          (cacheObj.expireTimestamp - new Date().getTime()) / 1000
        );
      }
    }

    lockOk = await cache.checkLock(key, options.retry);
    if (lockOk !== true) throw new Error(CacheErrorMessages.locked);

    await client().set(redisPrefix + key, JSON.stringify(cacheObj));
    if (expireTimeSeconds) {
      await client().expire(redisPrefix + key, expireTimeSeconds);
      return {
        key,
        value: cacheObj.value,
        expireTimestamp: cacheObj.expireTimestamp,
        createdAt: cacheObj.createdAt,
        lastReadAt,
      };
    } else {
      return {
        key,
        value: cacheObj.value,
        expireTimestamp: cacheObj.expireTimestamp,
        createdAt: cacheObj.createdAt,
        lastReadAt,
      };
    }
  }

  /**
   * Delete an item in the cache.  Will throw an error if the item named by `key` is locked.
   * Automatically handles `api.cache.redisPrefix`
   */
  export async function destroy(key: string): Promise<boolean> {
    const lockOk = await cache.checkLock(key, null);
    if (!lockOk) throw new Error(CacheErrorMessages.locked);

    const count = await client().del(redisPrefix + key);
    let response = true;
    if (count !== 1) {
      response = false;
    }
    return response;
  }

  /**
   * Save an item in the cache.  If an item is already in the cache with the same key, it will be overwritten.  Throws an error if the object is already in the cache and is locked.
   * Automatically handles `api.cache.redisPrefix`
   */
  export async function save(
    key: string,
    value: any,
    expireTimeMS?: number
  ): Promise<boolean> {
    let expireTimeSeconds = null;
    let expireTimestamp = null;
    if (expireTimeMS !== null) {
      expireTimeSeconds = Math.ceil(expireTimeMS / 1000);
      expireTimestamp = new Date().getTime() + expireTimeMS;
    }

    const cacheObj = {
      value: value,
      expireTimestamp: expireTimestamp,
      createdAt: new Date().getTime(),
      readAt: null as number,
    };

    const lockOk = await cache.checkLock(key, null);
    if (!lockOk) throw new Error(CacheErrorMessages.locked);

    await client().set(redisPrefix + key, JSON.stringify(cacheObj));
    if (expireTimeSeconds) {
      await client().expire(redisPrefix + key, expireTimeSeconds);
    }
    return true;
  }

  /**
   * Push an item to a shared queue/list in redis.
   * Automatically handles `api.cache.redisPrefix`
   */
  export async function push(key: string, item: any): Promise<boolean> {
    const object = JSON.stringify({ data: item });
    await client().rpush(redisPrefix + key, object);
    return true;
  }

  /**
   * Pop (get) an item to a shared queue/list in redis.
   * Automatically handles `api.cache.redisPrefix`
   */
  export async function pop(key: string): Promise<boolean> {
    const object = await client().lpop(redisPrefix + key);
    if (!object) {
      return null;
    }
    const item = JSON.parse(object);
    return item.data;
  }

  /**
   * Check how many items are stored in a shared queue/list in redis.
   */
  export async function listLength(key: string): Promise<number> {
    return client().llen(redisPrefix + key);
  }

  /**
   * Lock an item in redis (can be a list or a saved item) to this Actionhero process.
   */
  export async function lock(
    key: string,
    expireTimeMS: number = lockDuration
  ): Promise<boolean> {
    const lockOk = await cache.checkLock(key, null);
    if (!lockOk) {
      return false;
    }

    const result = await client().setnx(lockPrefix + key, lockName());
    if (!result) {
      return false;
    } // value was already set, so we cannot obtain the lock

    await client().expire(lockPrefix + key, Math.ceil(expireTimeMS / 1000));

    return true;
  }

  /**
   * Unlock an item in redis (can be a list or a saved item) which was previously locked by this Actionhero process.
   */
  export async function unlock(key: string): Promise<boolean> {
    const lockOk = await cache.checkLock(key, null);

    if (!lockOk) {
      return false;
    }

    await client().del(lockPrefix + key);
    return true;
  }

  export async function checkLock(
    key: string,
    retry: boolean | number = false,
    startTime: number = new Date().getTime()
  ): Promise<boolean> {
    const lockedBy = await client().get(lockPrefix + key);
    if (lockedBy === lockName() || lockedBy === null) {
      return true;
    } else {
      const delta = new Date().getTime() - startTime;
      if (!retry || delta > retry) {
        return false;
      }

      await utils.sleep(lockRetry);
      return cache.checkLock(key, retry, startTime);
    }
  }
}
