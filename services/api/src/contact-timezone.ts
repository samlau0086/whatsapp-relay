type CallingCodeTimeZone={country:string;timeZone:string};

// Representative business time zone for each calling code. Contacts in countries
// with multiple zones can override this with an explicit IANA time zone.
const CALLING_CODE_TIMEZONES:Record<string,CallingCodeTimeZone>={
  "1":{country:"美国/加拿大",timeZone:"America/New_York"},
  "7":{country:"俄罗斯/哈萨克斯坦",timeZone:"Europe/Moscow"},
  "20":{country:"埃及",timeZone:"Africa/Cairo"},"27":{country:"南非",timeZone:"Africa/Johannesburg"},
  "30":{country:"希腊",timeZone:"Europe/Athens"},"31":{country:"荷兰",timeZone:"Europe/Amsterdam"},"32":{country:"比利时",timeZone:"Europe/Brussels"},"33":{country:"法国",timeZone:"Europe/Paris"},"34":{country:"西班牙",timeZone:"Europe/Madrid"},"36":{country:"匈牙利",timeZone:"Europe/Budapest"},"39":{country:"意大利",timeZone:"Europe/Rome"},
  "40":{country:"罗马尼亚",timeZone:"Europe/Bucharest"},"41":{country:"瑞士",timeZone:"Europe/Zurich"},"43":{country:"奥地利",timeZone:"Europe/Vienna"},"44":{country:"英国",timeZone:"Europe/London"},"45":{country:"丹麦",timeZone:"Europe/Copenhagen"},"46":{country:"瑞典",timeZone:"Europe/Stockholm"},"47":{country:"挪威",timeZone:"Europe/Oslo"},"48":{country:"波兰",timeZone:"Europe/Warsaw"},"49":{country:"德国",timeZone:"Europe/Berlin"},
  "51":{country:"秘鲁",timeZone:"America/Lima"},"52":{country:"墨西哥",timeZone:"America/Mexico_City"},"53":{country:"古巴",timeZone:"America/Havana"},"54":{country:"阿根廷",timeZone:"America/Argentina/Buenos_Aires"},"55":{country:"巴西",timeZone:"America/Sao_Paulo"},"56":{country:"智利",timeZone:"America/Santiago"},"57":{country:"哥伦比亚",timeZone:"America/Bogota"},"58":{country:"委内瑞拉",timeZone:"America/Caracas"},
  "60":{country:"马来西亚",timeZone:"Asia/Kuala_Lumpur"},"61":{country:"澳大利亚",timeZone:"Australia/Sydney"},"62":{country:"印度尼西亚",timeZone:"Asia/Jakarta"},"63":{country:"菲律宾",timeZone:"Asia/Manila"},"64":{country:"新西兰",timeZone:"Pacific/Auckland"},"65":{country:"新加坡",timeZone:"Asia/Singapore"},"66":{country:"泰国",timeZone:"Asia/Bangkok"},
  "81":{country:"日本",timeZone:"Asia/Tokyo"},"82":{country:"韩国",timeZone:"Asia/Seoul"},"84":{country:"越南",timeZone:"Asia/Ho_Chi_Minh"},"86":{country:"中国",timeZone:"Asia/Shanghai"},"90":{country:"土耳其",timeZone:"Europe/Istanbul"},"91":{country:"印度",timeZone:"Asia/Kolkata"},"92":{country:"巴基斯坦",timeZone:"Asia/Karachi"},"93":{country:"阿富汗",timeZone:"Asia/Kabul"},"94":{country:"斯里兰卡",timeZone:"Asia/Colombo"},"95":{country:"缅甸",timeZone:"Asia/Yangon"},"98":{country:"伊朗",timeZone:"Asia/Tehran"},
  "211":{country:"南苏丹",timeZone:"Africa/Juba"},"212":{country:"摩洛哥",timeZone:"Africa/Casablanca"},"213":{country:"阿尔及利亚",timeZone:"Africa/Algiers"},"216":{country:"突尼斯",timeZone:"Africa/Tunis"},"218":{country:"利比亚",timeZone:"Africa/Tripoli"},
  "234":{country:"尼日利亚",timeZone:"Africa/Lagos"},"251":{country:"埃塞俄比亚",timeZone:"Africa/Addis_Ababa"},"254":{country:"肯尼亚",timeZone:"Africa/Nairobi"},"255":{country:"坦桑尼亚",timeZone:"Africa/Dar_es_Salaam"},"256":{country:"乌干达",timeZone:"Africa/Kampala"},
  "351":{country:"葡萄牙",timeZone:"Europe/Lisbon"},"352":{country:"卢森堡",timeZone:"Europe/Luxembourg"},"353":{country:"爱尔兰",timeZone:"Europe/Dublin"},"354":{country:"冰岛",timeZone:"Atlantic/Reykjavik"},"358":{country:"芬兰",timeZone:"Europe/Helsinki"},
  "380":{country:"乌克兰",timeZone:"Europe/Kyiv"},"420":{country:"捷克",timeZone:"Europe/Prague"},"421":{country:"斯洛伐克",timeZone:"Europe/Bratislava"},
  "852":{country:"中国香港",timeZone:"Asia/Hong_Kong"},"853":{country:"中国澳门",timeZone:"Asia/Macau"},"855":{country:"柬埔寨",timeZone:"Asia/Phnom_Penh"},"856":{country:"老挝",timeZone:"Asia/Vientiane"},"880":{country:"孟加拉国",timeZone:"Asia/Dhaka"},"886":{country:"中国台湾",timeZone:"Asia/Taipei"},
  "960":{country:"马尔代夫",timeZone:"Indian/Maldives"},"961":{country:"黎巴嫩",timeZone:"Asia/Beirut"},"962":{country:"约旦",timeZone:"Asia/Amman"},"963":{country:"叙利亚",timeZone:"Asia/Damascus"},"964":{country:"伊拉克",timeZone:"Asia/Baghdad"},"965":{country:"科威特",timeZone:"Asia/Kuwait"},"966":{country:"沙特阿拉伯",timeZone:"Asia/Riyadh"},"968":{country:"阿曼",timeZone:"Asia/Muscat"},"971":{country:"阿联酋",timeZone:"Asia/Dubai"},"972":{country:"以色列",timeZone:"Asia/Jerusalem"},"973":{country:"巴林",timeZone:"Asia/Bahrain"},"974":{country:"卡塔尔",timeZone:"Asia/Qatar"},"975":{country:"不丹",timeZone:"Asia/Thimphu"},"976":{country:"蒙古",timeZone:"Asia/Ulaanbaatar"},"977":{country:"尼泊尔",timeZone:"Asia/Kathmandu"},
};

export function inferContactTimeZone(phone:string):CallingCodeTimeZone|null{
  const digits=phone.replace(/\D/g,"");
  for(let length=3;length>=1;length--){const match=CALLING_CODE_TIMEZONES[digits.slice(0,length)];if(match)return match;}
  return null;
}

export function resolveContactTimeZone(phone:string,configured?:string|null){
  if(configured)return{timeZone:configured,source:"custom" as const,country:inferContactTimeZone(phone)?.country??null};
  const inferred=inferContactTimeZone(phone);
  return inferred?{...inferred,source:"country" as const}:{timeZone:"UTC",source:"fallback" as const,country:null};
}
