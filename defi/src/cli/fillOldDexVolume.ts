import BigNumber from "bignumber.js";

import {
  getDexVolumeRecord,
  putDailyDexVolumeRecord,
  putHourlyDexVolumeRecord,
  putMonthlyDexVolumeRecord,
} from "../dexVolumes/dexVolumeRecords";
import {
  calcIsNewDay,
  getTimestampAtStartOfHour,
  getTimestampAtStartOfDayUTC,
  getTimestampAtStartOfMonth,
  getTimestampAtStartOfNextMonth,
} from "../utils/date";
import { getChainBlocksRetry } from "./utils";

import {
  AllEcosystemVolumes,
  ChainBlocks,
  DailyEcosystemVolumes,
  Ecosystem,
  FetchResult,
  HourlyEcosystemVolumes,
  HourlyVolumesResult,
  MonthlyEcosystemVolumes,
  TimestampBlock,
  TimestampVolumes,
} from "../../src/dexVolumes/dexVolume.types";

import * as dexAdapters from "../../DefiLlama-Adapters/dexVolumes";

const HOUR = 3600;
const DAY = HOUR * 24;

type Fetch = (timestamp: number, chainBlocks: ChainBlocks) => FetchResult;

const getBlocksFromStart = async (
  start: number,
  ecosystem: Ecosystem,
  end: number
) => {
  const blocks = [];
  // TODO optimize by storing all blocks in db for one query

  // Get everyday up to today
  for (let timestamp = start; timestamp <= end; timestamp += DAY) {
    blocks.push(getChainBlocksRetry(timestamp, ecosystem));
  }

  // Get last 25 hours
  for (let i = 0; i < 25; i++) {
    blocks.push(getChainBlocksRetry(end - HOUR * i, ecosystem));
  }

  // TODO add error report
  const allBlocksRes = await Promise.all(blocks);

  return allBlocksRes.reduce((acc: TimestampBlock, curr) => {
    acc[curr.inputTimestamp] = curr.block;
    return acc;
  }, {});
};

const getVolumesFromStart = async ({
  blocks,
  ecosystem,
  fetch,
  start,
  end,
}: {
  blocks: TimestampBlock;
  ecosystem: Ecosystem;
  fetch: Fetch;
  start: number;
  end: number;
}) => {
  const volumes = [];

  // here add start of day or prev day if timestamp starts at 12:00

  // Get everyday up to today
  for (let timestamp = start; timestamp <= end; timestamp += DAY) {
    const chainBlocks = { [ecosystem]: blocks[timestamp] };
    volumes.push(fetch(timestamp, chainBlocks));
  }

  // Get last 25 hours
  for (let i = 0; i < 25; i++) {
    const timestamp = end - HOUR * i;
    const chainBlocks = { [ecosystem]: blocks[timestamp] };
    volumes.push(fetch(timestamp, chainBlocks));
  }

  // TODO add error report
  const allVolumeRes = await Promise.all(volumes);

  return allVolumeRes.reduce((acc: TimestampVolumes, curr: FetchResult) => {
    const { dailyVolume, timestamp, totalVolume } = curr;
    acc[timestamp] = {
      totalVolume,
      dailyVolume,
    };
    return acc;
  }, {});
};

const fetchEcosystemsFromStart = async ({
  ecosystem,
  fetch,
  start,
  end,
}: {
  ecosystem: Ecosystem;
  fetch: Fetch;
  start: number | any;
  end: number;
}) => {
  const startTimestamp = typeof start === "number" ? start : await start();

  // TODO add error report
  const blocks = await getBlocksFromStart(startTimestamp, ecosystem, end);
  const volumes = await getVolumesFromStart({
    blocks,
    ecosystem,
    fetch,
    start: startTimestamp,
    end,
  });

  return {
    ecosystem,
    volumes,
    startTimestamp,
  };
};

const fetchAllEcosystemsFromStart = async (
  id: number,
  end: number
): Promise<AllEcosystemVolumes> => {
  const {
    name,
    module: dexModule,
  }: {
    name: string;
    module: keyof typeof dexAdapters;
  } = await getDexVolumeRecord(id);

  // TODO handle breakdown
  const { volume, breakdown }: any = dexAdapters[dexModule];

  const ecosystems: any[] = Object.keys(volume);

  return (
    await Promise.all(
      ecosystems.map((ecosystem: Ecosystem) => {
        // TODO add customBackfill
        const { fetch, start } = volume[ecosystem];
        return fetchEcosystemsFromStart({ ecosystem, fetch, start, end });
      })
    )
  ).reduce(
    (
      acc: {
        [x: string]: { volumes: TimestampVolumes; startTimestamp: number };
      },
      { ecosystem, volumes, startTimestamp }
    ) => {
      acc[ecosystem] = { volumes, startTimestamp };
      return acc;
    },
    {}
  );
};

const calcDailyVolume = ({
  allEcosystemVolumes,
  ecosystemNames,
  timestamp,
  end,
}: {
  allEcosystemVolumes: AllEcosystemVolumes;
  ecosystemNames: string[];
  timestamp: number;
  end: number;
}) => {
  const dailySumVolume = new BigNumber(0);
  const totalSumVolume = new BigNumber(0);
  const dailyEcosystemVolumes: DailyEcosystemVolumes = {};

  ecosystemNames.forEach((ecosystem) => {
    const { volumes } = allEcosystemVolumes[ecosystem];
    const currTotalVolume = volumes[timestamp]?.totalVolume;
    if (
      volumes[timestamp] &&
      !volumes[timestamp + DAY] &&
      end - timestamp > DAY
    ) {
      throw new Error(`Missing data on ${timestamp + DAY} for ${ecosystem}`);
    }
    // Next day volume or up to current timestamp
    const nextTotalVolume =
      volumes[timestamp + DAY]?.totalVolume || volumes[end]?.totalVolume;

    if (currTotalVolume !== undefined && nextTotalVolume !== undefined) {
      const bigNumCurrTotalVol = new BigNumber(currTotalVolume);
      const bigNumNextTotalVol = new BigNumber(nextTotalVolume);
      const bigNumDailyVolume = bigNumNextTotalVol.minus(bigNumCurrTotalVol);

      dailySumVolume.plus(bigNumDailyVolume);
      totalSumVolume.plus(bigNumCurrTotalVol);

      dailyEcosystemVolumes[ecosystem] = {
        dailyVolume: bigNumDailyVolume.toString(),
        totalVolume: currTotalVolume,
      };
    }
  });

  return {
    dailyVolume: dailySumVolume.toString(),
    totalVolume: totalSumVolume.toString(),
    ecosystems: dailyEcosystemVolumes,
  };
};

const calcHourlyVolume = ({
  allEcosystemVolumes,
  ecosystemNames,
  timestamp,
}: {
  allEcosystemVolumes: AllEcosystemVolumes;
  ecosystemNames: string[];
  timestamp: number;
}): HourlyVolumesResult => {
  const prevTimestamp = timestamp - HOUR;
  const startDayofPrev = getTimestampAtStartOfDayUTC(prevTimestamp);

  const dailySumVolume = new BigNumber(0);
  const hourlySumVolume = new BigNumber(0);
  const totalSumVolume = new BigNumber(0);
  const hourlyEcosystemVolumes: HourlyEcosystemVolumes = {};

  ecosystemNames.forEach((ecosystem) => {
    const { volumes } = allEcosystemVolumes[ecosystem];

    const { totalVolume: currTotalVolume } = volumes[timestamp];
    const { totalVolume: prevTotalVolume } = volumes[prevTimestamp];

    const { totalVolume: prevDayTotalVolume } = volumes[startDayofPrev];

    // Calc values given totalVolume
    if (currTotalVolume && prevTotalVolume && prevDayTotalVolume) {
      const bigNumCurrTotalVol = new BigNumber(currTotalVolume);
      const bigNumPrevTotalVol = new BigNumber(prevTotalVolume);
      const bigNumPrevDayTotalVol = new BigNumber(prevDayTotalVolume);

      const bigNumDailyVolume = bigNumCurrTotalVol.minus(bigNumPrevDayTotalVol);
      const bigNumHourlyVolume = bigNumCurrTotalVol.minus(bigNumPrevTotalVol);

      dailySumVolume.plus(bigNumDailyVolume);
      hourlySumVolume.plus(bigNumHourlyVolume);
      totalSumVolume.plus(bigNumCurrTotalVol);

      hourlyEcosystemVolumes[ecosystem] = {
        dailyVolume: bigNumDailyVolume.toString(),
        hourlyVolume: bigNumHourlyVolume.toString(),
        totalVolume: currTotalVolume,
      };
    }
  });

  return {
    dailyVolume: dailySumVolume.toString(),
    hourlyVolume: hourlySumVolume.toString(),
    totalVolume: totalSumVolume.toString(),
    ecosystems: hourlyEcosystemVolumes,
  };
};

const calcMonthlyVolume = ({
  allEcosystemVolumes,
  ecosystemNames,
  timestamp,
  end,
}: {
  allEcosystemVolumes: AllEcosystemVolumes;
  ecosystemNames: string[];
  timestamp: number;
  end: number;
}) => {
  const monthlySumVolume = new BigNumber(0);
  const totalSumVolume = new BigNumber(0);
  const monthlyEcosystemVolumes: MonthlyEcosystemVolumes = {};

  ecosystemNames.forEach((ecosystem) => {
    const { volumes } = allEcosystemVolumes[ecosystem];

    const startMonthTimestamp = getTimestampAtStartOfMonth(timestamp);
    // For current month up to current hour
    const nextTimestamp =
      getTimestampAtStartOfNextMonth(timestamp) > end
        ? end
        : getTimestampAtStartOfNextMonth(timestamp);

    // For first instance when contract did not launch at first of month
    const currTotalVolume =
      volumes[startMonthTimestamp]?.totalVolume ||
      volumes[timestamp]?.totalVolume;
    const nextTotalVolume = volumes[nextTimestamp]?.totalVolume;

    if (currTotalVolume !== undefined && nextTotalVolume !== undefined) {
      const bigNumCurrTotalVol = new BigNumber(currTotalVolume);
      const bigNumNextTotalVol = new BigNumber(nextTotalVolume);
      const bigNumMonthlyVolume = bigNumNextTotalVol.minus(bigNumCurrTotalVol);

      monthlySumVolume.plus(bigNumMonthlyVolume);
      totalSumVolume.plus(bigNumCurrTotalVol);

      monthlyEcosystemVolumes[ecosystem] = {
        monthlyVolume: bigNumMonthlyVolume.toString(),
        totalVolume: currTotalVolume,
      };
    }
  });

  return {
    monthlyVolume: monthlySumVolume.toString(),
    totalVolume: totalSumVolume.toString(),
    ecosystems: monthlyEcosystemVolumes,
  };
};

const fillOldDexVolume = async (id: number) => {
  const currentTimestamp = getTimestampAtStartOfHour(Date.now() / 1000);
  const allEcosystemVolumes = await fetchAllEcosystemsFromStart(
    id,
    currentTimestamp
  );
  const ecosystemNames = Object.keys(allEcosystemVolumes);

  const earliestTimestamp = ecosystemNames.reduce(
    (acc, curr) =>
      acc > allEcosystemVolumes[curr].startTimestamp
        ? allEcosystemVolumes[curr].startTimestamp
        : acc,
    Number.MAX_SAFE_INTEGER
  );

  const allDbWrites = [];

  for (
    let timestamp = getTimestampAtStartOfDayUTC(earliestTimestamp);
    timestamp < currentTimestamp;
    timestamp += DAY
  ) {
    const { dailyVolume, totalVolume, ecosystems } = calcDailyVolume({
      allEcosystemVolumes,
      ecosystemNames,
      timestamp,
      end: currentTimestamp,
    });

    allDbWrites.push(
      putDailyDexVolumeRecord({
        id,
        unix: timestamp - DAY,
        dailyVolume,
        totalVolume,
        ecosystems,
      })
    );
  }

  for (let i = 0; i < 24; i++) {
    const timestamp = currentTimestamp - HOUR * i;

    const { dailyVolume, hourlyVolume, totalVolume, ecosystems } =
      calcHourlyVolume({ allEcosystemVolumes, ecosystemNames, timestamp });

    allDbWrites.push(
      putHourlyDexVolumeRecord({
        id,
        unix: timestamp - HOUR,
        dailyVolume,
        hourlyVolume,
        totalVolume,
        ecosystems,
      })
    );
  }

  let monthlyVolTimestamp = earliestTimestamp;
  while (monthlyVolTimestamp < currentTimestamp) {
    const { monthlyVolume, totalVolume, ecosystems } = calcMonthlyVolume({
      allEcosystemVolumes,
      ecosystemNames,
      timestamp: monthlyVolTimestamp,
      end: currentTimestamp,
    });

    allDbWrites.push(
      putMonthlyDexVolumeRecord({
        id,
        unix: getTimestampAtStartOfMonth(monthlyVolTimestamp),
        monthlyVolume,
        totalVolume,
        ecosystems,
      })
    );
    monthlyVolTimestamp = getTimestampAtStartOfNextMonth(monthlyVolTimestamp);
  }

  // TODO unlock dex-volume at end to allow hourly CRON
};

// TODO fill multiple protocols
// TODO fill All protocols
