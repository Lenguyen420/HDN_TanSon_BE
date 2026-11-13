export function companyAnniversaryPipeline(date) {
  const year = Number(date.slice(0, 4));
  const day = date.slice(5);
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  // Celebrate February 29 on February 28 during non-leap years.
  const days = day === "02-28" && !leapYear ? "(?:02-28|02-29)" : day;
  return [
    {
      $match: {
        deletedAt: null,
        status: "active",
        company: { $type: "string" },
        companyFoundedAt: { $type: "string", $regex: `^\\d{4}-${days}$` },
      },
    },
    {
      $set: {
        companyName: { $trim: { input: "$company" } },
        companyKey: { $toLower: { $trim: { input: "$company" } } },
        foundedDate: {
          $dateFromString: {
            dateString: "$companyFoundedAt",
            format: "%Y-%m-%d",
            onError: null,
            onNull: null,
          },
        },
      },
    },
    { $match: { foundedDate: { $ne: null }, companyName: { $ne: "" } } },
    { $set: { years: { $subtract: [year, { $year: "$foundedDate" }] } } },
    { $match: { years: { $gte: 1 } } },
    { $sort: { _id: 1 } },
    {
      $group: {
        _id: { company: "$companyKey", foundedAt: "$companyFoundedAt" },
        company: { $first: "$companyName" },
        years: { $first: "$years" },
      },
    },
    {
      $set: {
        title: {
          $concat: [
            "Chúc mừng ",
            { $toString: "$years" },
            " năm thành lập ",
            "$company",
          ],
        },
        description: {
          $concat: [
            "Hôm nay ",
            date.slice(8) + "/" + date.slice(5, 7),
            ", ",
            "$company",
            " kỷ niệm ",
            { $toString: "$years" },
            " năm thành lập. Hội Doanh nghiệp Phường Tân Sơn kính chúc doanh nghiệp ngày càng phát triển và thành công.",
          ],
        },
      },
    },
    {
      $project: {
        _id: 0,
        id: {
          $concat: [
            `company-anniversary-${year}-`,
            "$_id.foundedAt",
            "-",
            "$_id.company",
          ],
        },
        title: 1,
        description: 1,
        paragraphs: ["$description"],
        category: { $literal: "Sinh nhật doanh nghiệp" },
        date: { $literal: date },
        time: { $literal: "00:00" },
        createdAt: { $literal: new Date(`${date}T00:00:00+07:00`) },
        scope: { $literal: "public" },
        source: { $literal: "company-anniversary" },
        company: 1,
        companyFoundedAt: "$_id.foundedAt",
        anniversaryYears: "$years",
        image: { $literal: "" },
      },
    },
  ];
}
