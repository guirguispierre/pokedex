import { NextResponse } from "next/server";
import { getSession } from "@/lib/session";
import { getGuild, getGuildChannels, getGuildRoles } from "@/lib/discord";

export async function GET() {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [guild, channels, roles] = await Promise.all([
      getGuild(),
      getGuildChannels(),
      getGuildRoles(),
    ]);

    // Use BigInt for Discord snowflake ID to avoid precision loss with large IDs
    const createdTimestamp = Number((BigInt(guild.id) >> 22n) + 1420070400000n);

    return NextResponse.json({
      name: guild.name,
      memberCount: guild.approximate_member_count,
      onlineCount: guild.approximate_presence_count,
      channelCount: channels.length,
      roleCount: roles.length,
      createdAt: new Date(createdTimestamp).toISOString(),
      icon: guild.icon ? `https://cdn.discordapp.com/icons/${guild.id}/${guild.icon}.png` : null,
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
