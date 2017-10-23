const Router = require('koa-router')
const route = new Router()
const { AccessFilter } = require('./auth')
const CsvStringify = require('csv-stringify')
const Archiver = require('archiver')
const { PassThrough } = require('stream')
const { verify, sign } = require('jsonwebtoken')

const GV = (obj, key) => {
    let keys = key.split('.')
    let cur = obj
    for (let key of keys) {
        if (cur && cur[key]) {
          cur = cur[key]
        } else {
          return ''
        }
    }
    return cur
}

const GNV = (obj, key) => GV(obj, key) || 0

const isLeaderText = val => val ? '领队' : ''

const withdrawText = val => val ? '退会' : ''

const genderText = val => {
    switch (val) {
        case 'm': return '男'
        case 'f': return '女'
        default:  return ''
    }
}

const idTypeText = val => {
    switch (val) {
        case 'mainland': return '中国大陆身份证'
        case 'sar':      return '港澳'
        case 'taiwan':   return '台胞证'
        case 'passport': return '护照'
        case 'other':    return '其它'
        default:         return ''
    }
}

const guardianTypeText = val => {
    switch(val) {
        case 'father': return '父'
        case 'mother': return '母'
        case 'other':  return '其他'
    }
}

const REPRESENTATIVE = {
    columns: [
        '领队标记',
        '退会标记',
        '学校',
        '会场',
        '姓名',
        '性别',
        '手机',
        '邮箱',
        '毕业时间',
        '证件类型',
        '证件号码',
        '监护人关系',
        '监护人姓名',
        '监护人手机',
        '监护人证件类型',
        '监护人证件号码',
        '备注',
    ],
    map: $ => [
       isLeaderText( GV($, 'is_leader') ),
       withdrawText( GV($, 'withdraw') ),
       GV($, 'school.school.name'),
       GV($, 'session.name'),
       GV($, 'contact.name'),
       genderText( GV($, 'contact.gender') ),
       GV($, 'contact.phone'),
       GV($, 'contact.email'),
       GV($, 'graduation_year'),
       idTypeText( GV($, 'identification.type') ),
       GV($, 'identification.number'),
       guardianTypeText( GV($, 'guardian.type') ),
       GV($, 'guardian.name'),
       GV($, 'guardian.phone'),
       idTypeText( GV($, 'guardian_identification.type') ),
       GV($, 'guardian_identification.number'),
       GV($, 'comment')
    ]
}

const BILLING = {
    columns: [ '学校', '类别', '项目', '数量/天数', '单价', '总价' ],
    map: $ => [
        GV($, 'paid_by.school.name'),
        GV($, 'items.type'),
        GV($, 'items.name'),
        GV($, 'items.amount'),
        GV($, 'items.price'),
        GV($, 'items.sum'),
    ]
}

const RESERVATION = {
    columns: [
        '学校',
        '酒店',
        '房型',
        '入住日期',
        '退房日期',
    ],
    map: $ => [
        GV($, 'school.school.name'),
        GV($, 'hotel.name'),
        GV($, 'hotel.type'),
        GV($, 'checkIn'),
        GV($, 'checkOut'),
    ]
}

const COMMITTEE = {
    columns: [
        '职能',
        '学校',
        '姓名',
        '性别',
        '手机',
        '邮箱',
        'QQ',
        '证件类型',
        '证件号码',
        '紧急联系人关系',
        '紧急联系人姓名',
        '紧急联系人手机',
        '紧急联系人证件类型',
        '紧急联系人证件号码',
        '来宁日期',
        '离宁日期',
        '酒店入住日期',
        '酒店退房日期',
        '备注'
    ],
    map: $ => [
       GV($, 'role'),
       GV($, 'school'),
       GV($, 'contact.name'),
       genderText( GV($, 'contact.gender') ),
       GV($, 'contact.phone'),
       GV($, 'contact.email'),
       GV($, 'contact.qq'),
       idTypeText( GV($, 'identification.type') ),
       GV($, 'identification.number'),
       guardianTypeText( GV($, 'guardian.type') ),
       GV($, 'guardian.name'),
       GV($, 'guardian.phone'),
       idTypeText( GV($, 'guardian_identification.type') ),
       GV($, 'guardian_identification.number'),
       GV($, 'arriveDate'),
       GV($, 'departDate'),
       GV($, 'checkInDate'),
       GV($, 'checkOutDate'),
       GV($, 'comment')
    ]
}

const VOLUNTEER = {
    columns: [
        '学校',
        '姓名',
        '性别',
        '手机',
        '邮箱',
        'QQ',
        '证件类型',
        '证件号码',
        '紧急联系人关系',
        '紧急联系人姓名',
        '紧急联系人手机',
        '紧急联系人证件类型',
        '紧急联系人证件号码',
        '来宁日期',
        '离宁日期',
        '酒店入住日期',
        '酒店退房日期',
        '备注'
    ],
    map: $ => [
       GV($, 'school'),
       GV($, 'contact.name'),
       genderText( GV($, 'contact.gender') ),
       GV($, 'contact.phone'),
       GV($, 'contact.email'),
       GV($, 'contact.qq'),
       idTypeText( GV($, 'identification.type') ),
       GV($, 'identification.number'),
       guardianTypeText( GV($, 'guardian.type') ),
       GV($, 'guardian.name'),
       GV($, 'guardian.phone'),
       idTypeText( GV($, 'guardian_identification.type') ),
       GV($, 'guardian_identification.number'),
       GV($, 'arriveDate'),
       GV($, 'departDate'),
       GV($, 'checkInDate'),
       GV($, 'checkOutDate'),
       GV($, 'comment')
    ]
}

const APPLICATION_CONTACT = {
    columns: [
        '学校',
        '联系人1',
        '性别2',
        '手机2',
        '邮箱2',
        '联系人2',
        '性别2',
        '手机2',
        '邮箱2',
    ],
    map: $ => [
       GV($, 'name'),
       GV($, 'contact.name'),
       genderText( GV($, 'contact.gender') ),
       GV($, 'contact.phone'),
       GV($, 'contact.email'),
       GV($, 'altContact.name'),
       genderText( GV($, 'altContact.gender') ),
       GV($, 'altContact.phone'),
       GV($, 'altContact.email'),
    ]
}

const createCsvStream = (cursor, columns, map) => {
    const stream = new CsvStringify()
    stream.write(columns)
    cursor.each( (err, $) => {
        if ($)
            stream.write( map($) )
        else
            stream.end()
    })
    return stream
}

const AGGREGATE_OPTS = {
    collation: {
        locale: 'zh'
    }
}

const LOOKUP_BILLING = [
    { $sort: { 'paid_by.school.name': 1 }},
    { $unwind: '$items' }
]

const LOOKUP_REPRESENTATIVE = [
    { $lookup: {
        localField: 'school',
        foreignField: '_id',
        from: 'school',
        as: 'school',
    } },
    { $lookup: {
        localField: 'session',
        foreignField: '_id',
        from: 'session',
        as: 'session',
    } },
    { $sort: { 'school.school.name': 1 } },
    { $unwind: '$school' },
    { $unwind: '$session' }
]

const LOOKUP_LEADER = [
    { $match: { 'is_leader': true } },
    ... LOOKUP_REPRESENTATIVE
]

const LOOKUP_RESERVATION = [
    { $lookup: {
        from: 'hotel',
        localField: 'hotel',
        foreignField: '_id',
        as: 'hotel'
    }},
    { $lookup: {
        from: 'school',
        localField: 'school',
        foreignField: '_id',
        as: 'school'
    } },
    { $sort: { 'school.school.name': 1 } },
    { $unwind: '$hotel' },
    { $unwind: '$school' },
]

const LOOKUP_COMMITTEE = [
    { $sort: { role: 1, 'contact.name': 1 } }
]

const LOOKUP_VOLUNTEER = [
    { $sort: { 'contact.name': 1 } }
]

const LOOKUP_SCHOOL_SEAT = [
    { $sort: { 'school.name': 1 } },
    { $project: {
        name: '$school.name',
        r1: '$seat.1',
        r2: {$ifNull: ['$seat.2', {}]}
    }}
]

const LOOKUP_APPLICATION_SEAT = [
    { $sort: { 'school.name': 1 } },
    { $project: {
        name: '$school.name',
        seat: '$seat'
    }}
]

const LOOKUP_APPLICATION_CONTACT = [
    { $sort: { 'school.name': 1 } },
    { $project: {
        name: '$school.name',
        contact: '$contact',
        altContact: '$altContact'
    }}
]

route.get('/export/representatives',
    AccessFilter('finance', 'admin'),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('representative').aggregate(LOOKUP_REPRESENTATIVE, AGGREGATE_OPTS),
            REPRESENTATIVE.columns,
            REPRESENTATIVE.map
        )
    }
)

route.get('/export/leaders',
    AccessFilter('finance', 'admin'),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('representative').aggregate(LOOKUP_LEADER, AGGREGATE_OPTS),
            REPRESENTATIVE.columns,
            REPRESENTATIVE.map
        )
    }
)

route.get('/export/billings',
    AccessFilter('finance', 'admin'),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('billing').aggregate(LOOKUP_BILLING, AGGREGATE_OPTS),
            BILLING.columns,
            BILLING.map
        )
    }
)

route.get('/export/reservations',
    AccessFilter('finance', 'admin'),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('reservation').aggregate(LOOKUP_RESERVATION, AGGREGATE_OPTS),
            RESERVATION.columns,
            RESERVATION.map
        )
    }
)

route.get('/export/committees',
    AccessFilter('finance', 'admin'),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('committee').aggregate(LOOKUP_COMMITTEE, AGGREGATE_OPTS),
            COMMITTEE.columns,
            COMMITTEE.map
        )
    }
)

route.get('/export/volunteers',
    AccessFilter('finance', 'admin'),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('volunteer').aggregate(LOOKUP_VOLUNTEER, AGGREGATE_OPTS),
            VOLUNTEER.columns,
            VOLUNTEER.map
        )
    }
)

route.get('/export/seats',
    AccessFilter('finance', 'admin'),
    async ctx => {
        const sessions = await ctx.db.collection('session')
            .find({ reserved: { $ne: true } })
            .map(({_id, name}) => ({ id: _id, name }))
            .toArray()
        const columns = ['学校', ...sessions.map($ => $.name)]
        const columnMapper = $ => [
            GV($, 'name'),
            ...sessions.map(({id}) => GNV($, `r1.${id}`) + GNV($, `r2.${id}`))
        ]
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('school').aggregate(LOOKUP_SCHOOL_SEAT, AGGREGATE_OPTS),
            columns,
            columnMapper
        )
    }
)

route.get('/export/applications/seats',
    AccessFilter('finance', 'admin'),
    async ctx => {
        const sessions = await ctx.db.collection('session')
            .find({ reserved: { $ne: true } })
            .map(({_id, name}) => ({ id: _id, name }))
            .toArray()
        const columns = ['学校', ...sessions.map($ => $.name)]
        const columnMapper = $ => [
            GV($, 'name'),
            ...sessions.map(({id}) => GNV($, `seat.${id}`))
        ]
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('application').aggregate(LOOKUP_APPLICATION_SEAT, AGGREGATE_OPTS),
            columns,
            columnMapper
        )
    }
)

route.get('/export/applications/contacts',
    AccessFilter('finance', 'admin'),
    async ctx => {
        ctx.status = 200
        ctx.set('content-type', 'text/csv;charset=utf-8')
        ctx.body = createCsvStream(
            ctx.db.collection('application').aggregate(LOOKUP_APPLICATION_CONTACT, AGGREGATE_OPTS),
            APPLICATION_CONTACT.columns,
            APPLICATION_CONTACT.map
        )
    }
)

const NameCreator = () => {
    let map = {}
    return (name) => {
        if (map[name]) {
            map[name] += 1
        } else {
            map[name] = 1
        }
        if (map[name] > 1)
            return name + '-' + map[name]
        else
            return name
    }
}

route.get('/export/committees/photos',
    async ctx => {
        if (!ctx.query.token && await AccessFilter('finance', 'admin')(ctx)){
            ctx.status = 201
            ctx.set('location', '?token='+sign(
                { 'export': 1 },
                ctx.JWT_SECRET,
                { expiresIn: '1 min' }
            ))
            ctx.body = ''
        } else {
            // verify token
            try {
                verify(ctx.query.token, ctx.JWT_SECRET)
            } catch(e) {
                ctx.status = 403
                ctx.body = { error: 'not authorized' }
                return
            }
            ctx.status = 200
            ctx.set('content-type', 'application/zip;charset=utf-8')
            let archiver = Archiver('zip', {store: true})
            ctx.body = archiver.pipe(new PassThrough())
            const committees = await ctx.db.collection('committee').aggregate(LOOKUP_COMMITTEE).toArray()
            const createName = NameCreator()
            for (let committee of committees) {
                const prefix = GV(committee, 'role') + '-' + GV(committee, 'contact.name')
                const name = createName(prefix) + '.jpg'
                const photo = await ctx.db.collection('image').findOne({ _id: committee.photoId })
                if (photo)
                    archiver.append(photo.buffer.buffer, { name, date: photo.created })
            }
            archiver.finalize()
        }
    }
)

module.exports = {
    routes: route.routes()
}
